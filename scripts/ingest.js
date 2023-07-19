#!/usr/bin/env node

import { queue } from "async";
import { program } from "commander";
import fs from "node:fs";
import readline from "node:readline";
import https from "node:https";
import fetch from "node-fetch";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { nanoid } from "nanoid";

program
  .requiredOption(
    "-c, --cluster <cluster>",
    "OpenSearch cluster url, example, http://localhost:9200"
  )
  .requiredOption(
    "-i, --index-name <name>",
    "The index where the data will be ingested"
  )
  .requiredOption("-f, --file <file>", "Path to the data file")
  .option("-u, --user <user>", "OpenSearch username")
  .option(
    "--text-field <textField>",
    "The text field of the ingested data",
    "text"
  )
  .option("--only-text", "only keep text field")
  .option(
    "--chunk-size <chunkSize>",
    "The text chunk size limit, if exceed limit, text will be split into multiple document.",
    Number,
    0
  )
  .option("--chunk-overlap <chunkOverlap>", "Text chunk overlap", Number, 200)
  .option("-p, --password <password>", "OpenSearch password")
  .option(
    "-b, --batch-size <batchSize>",
    "The number of documents to be sent to ingest in one request",
    Number,
    1
  )
  .option(
    "--concurrency <concurrency>",
    "The number of requests to run in parallel",
    Number,
    1
  )
  .option(
    "--split-doc <splitDoc>",
    "if exceed chunkSize, split the doc into multiple",
    Number,
    1
  );

program.parse();
const opts = program.opts();
const succeedDocsWriter = fs.createWriteStream("succeed_docs");
const failedDocsWriter = fs.createWriteStream("failed_docs");

let count = 0;
const batch = [];

function addToBatch(data) {
  if (batch.length >= opts.batchSize) {
    flush();
  }

  batch.push(data);
}

const q = queue((task, callback) => {
  let endpoint = task.bulk
    ? new URL(`${opts.indexName}/_bulk`, opts.cluster)
    : new URL(`${opts.indexName}/_doc/${task.documentId}`, opts.cluster);
  let headers = {
    "Content-Type": "application/json",
  };

  if (opts.user && opts.password) {
    headers = {
      ...headers,
      Authorization: `Basic ${Buffer.from(
        opts.user + ":" + opts.password
      ).toString("base64")}`,
    };
  }

  fetch(endpoint, {
    method: "POST",
    body: task.data,
    agent: new https.Agent({ rejectUnauthorized: false }),
    headers,
  })
    .then((res) => {
      return res.json();
    })
    .then((json) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(json);
        }, 1000);
      });
    })
    .then((json) => {
      if (json.error) {
        console.log("Error: ", JSON.stringify(json.error));
        // retry task
        q.push(task);
      } else if (json.errors) {
        const failed = [];
        const succeed = [];
        // when ingesting with _bulk, we will need to find out the failed documents and recreate the documents
        json.items.forEach((e) => {
          if (e.index.error) {
            failed.push(e.index._id);
            // addToBatch(task.rawData[e.index._id]);
            console.log("Error: ", JSON.stringify(e.index.error));
          } else {
            succeed.push(e.index._id);
          }
        });
        count = count + succeed.length;
        console.log(
          `Trying to create ${
            Object.keys(task.rawData).length
          } documents: Failed ${failed.length}/Succeed ${succeed.length}`
        );
        if (succeed.length) {
          succeedDocsWriter.write(succeed.join(",") + ",");
        }
        if (failed.length) {
          failedDocsWriter.write(failed.join(",") + ",");
        }
      } else {
        count = count + json.items.length;
        succeedDocsWriter.write(
          json.items.map((item) => item.index._id).join(",") + ","
        );
      }
      console.log(`${count} documents created`);
      callback();
      // RESUME reading file
      if (q.length() < 3) {
        rl.resume();
        console.log("RESUME reading file");
      }
    })
    .catch((e) => {
      console.log(e);
      // retry
      q.push(task);
      callback();
    });
}, opts.concurrency);

function flush() {
  let payload = "";
  const rawData = {};
  batch.forEach((data) => {
    rawData[data.id] = data;
    payload = payload + JSON.stringify({ index: { _id: data.id } }) + "\n";
    payload = payload + JSON.stringify(data) + "\n";
  });
  if (payload) {
    q.push({ data: payload, bulk: true, rawData });
    batch.length = 0;
  }
}

// Read json data file
const filepath = opts.file;
const rl = readline.createInterface({
  input: fs.createReadStream(filepath),
  crlfDelay: Infinity,
});

async function write(json) {
  const id = json.id;
  if (id === undefined || id === null || id === "") {
    json.id = nanoid();
  }

  const text = json[opts.textField]?.toString();

  if (text) {
    delete json[opts.textField];

    const results = [];
    let data = { ...json, text: text };
    if (opts.onlyText) {
      data = { text: text, id: json.id };
    }

    console.log("chunk size: ", opts.chunkSize);
    if (opts.chunkSize > 0) {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: opts.chunkSize,
        chunkOverlap: opts.chunkOverlap,
      });
      const docs = await splitter.createDocuments([text]);
      if (opts.splitDoc > 1) {
        docs.forEach((doc, i) => {
          results.push({
            ...data,
            text: doc.pageContent,
            id: `${data.id}_${i}`,
          });
        });
      } else {
        results.push({
          ...data,
          text: docs[0].pageContent,
        });
      }
    } else {
      results.push(data);
    }

    for (const d of results) {
      // request _bulk if batchSize > 1
      if (opts.batchSize > 1) {
        addToBatch(d);
      } else {
        q.push({
          data: JSON.stringify(d),
          bulk: false,
          documentId: data.id,
        });
      }
    }
  }
}

const run = () => {
  let lineCount = 0;
  rl.on("line", (line) => {
    console.log("Reading line: ", lineCount++);
    const json = JSON.parse(line);
    write(json);

    console.log("Queue size: ", q.length());
    if (q.length() > 10) {
      rl.pause();
    }
  });

  rl.on("close", () => {
    setTimeout(flush, 1000);
  });

  rl.on("pause", () => {
    console.log(`PAUSE reading file, task queue size: ${q.length()}`);
  });
};

console.log("Run with: ", opts);
run();

q.drain(() => {
  console.log("Done - all documents have been processed!");
});
