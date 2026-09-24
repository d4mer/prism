// Child process for cross-process concurrency tests (PRISM-27): a second,
// independent KnowledgeBase over the same bundle, like `prism maintain`
// running next to the server. Imports the BUILT core (dist), exactly as the
// real CLI does.
import { KnowledgeBase } from "../../dist/index.js";

const [, , root, prefix, countRaw] = process.argv;
const kb = new KnowledgeBase(root);
const count = Number(countRaw);
await Promise.all(
  Array.from({ length: count }, (_, i) =>
    kb.writeConcept(`/${prefix}/c${i}.md`, { type: "Note", title: `${prefix} ${i}` }, `from ${prefix}`, `Added [${prefix} ${i}](/${prefix}/c${i}.md).`)
  )
);
process.stdout.write("done");
