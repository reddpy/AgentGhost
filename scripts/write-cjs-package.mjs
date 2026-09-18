import { mkdirSync, writeFileSync } from "node:fs";

// The package is `"type": "module"`, so CommonJS output needs its own marker.
mkdirSync("dist/cjs", { recursive: true });
writeFileSync("dist/cjs/package.json", '{\n  "type": "commonjs"\n}\n');
