// Child process for PRISM-27 lock tests: acquires a bundle lock, prints
// "locked", holds it for holdMs (or forever when holdMs < 0, to be killed),
// then releases it.
import { Bundle, acquireLock } from "../../dist/index.js";

const [, , root, name, holdRaw] = process.argv;
const handle = await acquireLock(new Bundle(root), name, { purpose: `test holder ${process.pid}`, log: () => {} });
process.stdout.write("locked\n");
const hold = Number(holdRaw);
if (hold < 0) setInterval(() => {}, 1 << 30);
else {
  await new Promise((r) => setTimeout(r, hold));
  await handle.release();
  process.exit(0);
}
