import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";
import { testDatabase } from "./helpers/database.js";

const fixture = await testDatabase();
await fixture.db.runMigrations();
const socket = createServer();
await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
const port = (socket.address() as {port:number}).port;
await new Promise<void>(r => socket.close(() => r()));
const token = randomBytes(32).toString("hex");
const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: resolve("apps/web"), stdio: ["ignore", "pipe", "pipe"],
  env: {...process.env, ADMIN_API_TOKEN: token, DATABASE_URL: (fixture.db.options as {url:string}).url, NEXT_TELEMETRY_DISABLED:"1"},
});
let log="";
child.stdout.on("data", v => { log += v; });
child.stderr.on("data", v => { log += v; });
const base = `http://127.0.0.1:${port}`;
try {
  let ready=false;
  for(let i=0;i<80;i++) {
    if(child.exitCode!==null)throw new Error(`Web process failed: ${log}`);
    try { if((await fetch(`${base}/api/health`)).ok){ready=true;break;} } catch {}
    await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(ready,"Web process did not start");
  assert.equal((await fetch(`${base}/api/admin/games`)).status,401);
  const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
  const created=await fetch(`${base}/api/admin/games`,{method:"POST",headers,body:JSON.stringify({slug:"http-smoke",name:"合成 HTTP 验证"})});
  assert.equal(created.status,201,await created.clone().text());
  const result=JSON.parse(await created.text());
  assert.ok(result.data.id);
  const listed=await fetch(`${base}/api/admin/games`,{headers});
  assert.equal(listed.status,200);
  assert.equal(JSON.parse(await listed.text()).data.total,1);
  const spec=await fetch(`${base}/api/admin/openapi`,{headers});
  assert.equal(spec.status,200);
  assert.equal(JSON.parse(await spec.text()).openapi,"3.1.0");
  console.info("PASS production HTTP: auth, PostgreSQL create/list, OpenAPI");
} finally {
  if(child.exitCode===null){const exited=once(child,"exit");child.kill("SIGTERM");await exited;}
  await fixture.close();
}
