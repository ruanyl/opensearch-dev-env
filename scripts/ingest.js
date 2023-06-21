#!/usr/bin/env node

import { queue } from "async";
import { program } from "commander";
import fs from "node:fs";
import readline from "node:readline";
// import https from 'node:https';
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
  .option("--only-text <onlyText>", "only keep text field", false)
  .option(
    "--chunk-size <chunkSize>",
    "The text chunk size limit, if exceed limit, text will be split into multiple document.",
    Number,
    1000
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
  );

program.parse();
const opts = program.opts();

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
    // agent: new https.Agent({rejectUnauthorized: false}),
    headers,
  })
    .then((res) => {
      res.json().then((json) => {
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
              addToBatch(task.rawData[e.index._id]);
              console.log("Error: ", JSON.stringify(e.index.error));
            } else {
              succeed.push(e.index._id);
            }
          });
          count = count + succeed.length;
          console.log(
            `Trying to create ${
              Object.keys(task.rawData).length
            } documents: Failed ${failed.length}/Succeed ${
              succeed.length
            } (Retrying ${failed})`
          );
        } else {
          count = count + json.items.length;
        }
        callback();
      });
    })
    .then(() => {
      console.log(`${count} documents created`);
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

function write(json) {
  const id = json.id;
  if (id === undefined || id === null || id === "") {
    json.id = nanoid();
  }

  const textField = opts.textField;
  const chunkSize = opts.chunkSize ? parseInt(opts.chunkSize) : 1000;
  const chunkOverlap = opts.chunkOverlap ? parseInt(opts.chunkOverlap) : 200;
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: chunkSize,
    chunkOverlap: chunkOverlap,
  });
  const text = json[textField]?.toString();

  if (text) {
    splitter.createDocuments([text]).then((docs) => {
      docs.forEach((d, i) => {
        let data = { ...json, text: d.pageContent };
        if (opts.onlyText) {
          data = { text: d.pageContent, id: json.id };
        }
        if (docs.length > 1) {
          data.id = `${data.id}_${i}`;
        }

        // request _bulk if batchSize > 1
        if (opts.batchSize > 1) {
          addToBatch(data);
        } else {
          q.push({
            data: JSON.stringify(data),
            bulk: false,
            documentId: data.id,
          });
        }
      });
    });
  }
  // TODO: future improvement: supports ingesting raw documents without splitting
}

const run = () => {
  rl.on("line", (line) => {
    const json = JSON.parse(line);
    write(json);

    if (q.length() > 10) {
      rl.pause();
      console.log(`PAUSE reading file, task queue size: ${q.length()}`);
    }
  });

  rl.on("close", () => {
    setTimeout(flush, 1000);
  });
};

console.log("Run with: ", opts);
run();

q.drain(() => {
  console.log("Done - all documents have been processed!");
});
