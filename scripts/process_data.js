import fs from "node:fs";
import readline from "node:readline";

function run() {
  let lineCount = 0;
  const writer = fs.createWriteStream("meta_Sports_and_Outdoors_test.json");
  const reader = fs.createReadStream(
    "/Users/ruanyl/Downloads/meta_Sports_and_Outdoors.json"
  );

  const rl = readline.createInterface({
    input: reader,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    console.log("Read line: ", lineCount++);
    const raw = JSON.parse(line);
    if (raw.description || raw.title) {
      let text = "";
      if (raw.title && raw.title.length < 500) {
        text = `${raw.title}`;
      }
      if (raw.description) {
        text = `${text}. ${raw.description}`;
      }
      if (
        text &&
        text.split(" ").length >= 30 &&
        raw.imageURLHighRes &&
        raw.imageURLHighRes.length > 0
      ) {
        const data = {
          text: text,
          imageURL: raw.imageURLHighRes,
          id: raw.asin,
        };
        writer.write(`${JSON.stringify(data)}\n`);
      }
    }
  });
}

run();
