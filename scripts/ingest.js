#!/usr/bin/env node

import { queue } from "async";
import { program } from "commander";
import fs from "node:fs";
import readline from "node:readline";
import fetch from "node-fetch";

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
  .option(
    "--text-limit <textLimit>",
    "The text size limit, if exceed limit, text will be split into multiple document. Text won't be split by default"
  )
  .option("-p, --password <password>", "OpenSearch password")
  .option(
    "-b, --batch-size <batchSize>",
    "The number of documents to be sent to ingest at a given time",
    1
  );

program.parse();
const opts = program.opts();
const failedTasks = [];

function split(text, limit) {
  if (text.length <= limit) {
    return [text];
  }
  let remainingText = text;
  const result = [];

  while (remainingText.length > limit) {
    let splitPoint = limit;
    while (remainingText.charAt(splitPoint) !== " " && splitPoint >= 0) {
      splitPoint = splitPoint - 1;
    }
    result.push(remainingText.substring(0, splitPoint));
    remainingText = remainingText.substring(splitPoint);
  }
  result.push(remainingText);
  return result;
}

const q = queue((task, callback) => {
  const endpoint = new URL(`${opts.indexName}/_doc`, opts.cluster);
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
    headers,
  })
    .then((res) => {
      res.json().then((d) => {
        console.log(d);
        if (d.error) {
          failedTasks.push(task);
        }
        callback();
      });
    })
    .catch((e) => {
      console.log(e);
      failedTasks.push(task);
      callback();
    });
}, opts.batchSize);

const run = (options) => {
  const textField = opts.textField;
  const textLimit = opts.textLimit;

  const filepath = options.file;
  const rl = readline.createInterface({
    input: fs.createReadStream(filepath),
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const json = JSON.parse(line);
    const text = json[textField];
    // if text limit is set, split the text into multiple documents
    if (text && textLimit) {
      split(json.text, parseInt(textLimit)).map((text, i) => {
        const data = { ...json, text };
        if ("id" in data) {
          data.id = `${data.id}_${i}`;
        }
        q.push({ data: JSON.stringify(data) });
      });
    } else {
      q.push({ data: line });
    }
  });
};

run(opts);

q.drain(() => {
  console.log("Done - all documents have been processed!");
  if (failedTasks.length > 0) {
    console.log(`${failedTasks.length} tasks failed!`);
    console.log("Failed tasks: ", failedTasks);
  }
});
