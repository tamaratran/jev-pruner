const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const { execFileSync } = require("node:child_process");

const observations = { inference: false, passed: false, stage: "storage" };

async function main() {
  const disk = fs.statfsSync(process.cwd());
  const storageMiB = Number(process.argv[2]);
  const freeBytes = disk.bavail * disk.bsize;
  Object.assign(observations, {
    architecture: process.arch, node: process.version,
    storageRequestedMiB: storageMiB, reportedFreeBytes: freeBytes,
    storageCapacityVerified: Number.isSafeInteger(freeBytes),
  });
  if (process.arch !== "x64" || freeBytes < storageMiB * 1024 ** 2) {
    throw new Error("Architecture or available storage does not meet task requirements");
  }
  observations.stage = "credential-permissions";
  for (const directory of ["/opt/jev-eval/login", "/opt/jev-eval/auth"]) {
    if ((fs.statSync(directory).mode & 0o777) !== 0o700 ||
        (fs.statSync(`${directory}/.credentials.json`).mode & 0o777) !== 0o600) {
      throw new Error("Subscription credential permissions are not private");
    }
  }
  observations.stage = "sparse-file";
  const sparse = "/opt/jev-eval/sparse-probe";
  const descriptor = fs.openSync(sparse, "wx+", 0o600);
  try {
    const size = 32 * 1024 ** 3;
    fs.ftruncateSync(descriptor, size);
    observations.reportedAllocatedBytes = fs.fstatSync(descriptor).blocks * 512;
    const lastByte = Buffer.alloc(1);
    if (fs.readSync(descriptor, lastByte, 0, 1, size - 1) !== 1 || lastByte[0] !== 0) {
      throw new Error("Large truncated file did not read back zero-filled");
    }
    fs.writeSync(descriptor, Buffer.from([1]), 0, 1, size - 1);
    if (fs.readSync(descriptor, lastByte, 0, 1, size - 1) !== 1 || lastByte[0] !== 1) {
      throw new Error("Large-file random write did not read back");
    }
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(sparse);
  }
  observations.stage = "loopback-tcp";
  const server = net.createServer(socket => socket.end("probe"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    await new Promise((resolve, reject) => {
      const client = net.connect(address.port, "127.0.0.1");
      client.setTimeout(5000, () => client.destroy(new Error("Loopback timeout")));
      client.on("error", reject);
      client.resume();
      client.on("end", resolve);
    });
  } finally {
    server.close();
  }
  observations.stage = "capabilities";
  const capabilities = {};
  for (const binary of ["qemu-system-x86_64", "qemu-system-i386", "valgrind", "gdb"]) {
    try {
      capabilities[binary] = execFileSync(binary, ["--version"], {
        encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
      }).split("\n")[0];
    } catch {
      capabilities[binary] = null;
    }
  }
  const cgroup = {};
  for (const name of ["cpu.max", "memory.max"]) {
    const path = `/sys/fs/cgroup/${name}`;
    cgroup[name] = fs.existsSync(path) ? fs.readFileSync(path, "utf8").trim() : null;
  }
  fs.writeFileSync("/logs/agent/modal-preflight.json", JSON.stringify({
    ...observations, passed: true, stage: "completed", kernel: os.release(),
    largeFile32GiB: true, physicalSparseAllocationVerified: null,
    loopbackTcp: true, privateSubscriptionPermissions: true, cgroup, capabilities,
    runtimeUnknowns: "Physical disk capacity/allocation, guest boot, VNC, ptrace/Valgrind and task verifiers not verified",
  }, null, 2));
}

main().catch(error => {
  fs.writeFileSync("/logs/agent/modal-preflight.json", JSON.stringify({
    ...observations, error: error.message,
  }, null, 2));
  console.error(`Modal capability probe failed at ${observations.stage}: ${error.message}`);
  process.exitCode = 1;
});
