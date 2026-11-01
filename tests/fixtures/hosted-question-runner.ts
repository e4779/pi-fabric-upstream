// A hosted runner whose remote side outlives the resident host, like a daemon
// session: it keeps one open question in a backend file and, as the
// pi-fabric-daemon runner does, asks it again through each reporter that
// attaches until an answer arrives. Whatever a reporter returns, including
// { cancelled: true }, is delivered to the backend as the question's answer.
// The resident host imports this module (runnerModule) in every generation.
import fs from "node:fs";
import path from "node:path";
import { registerAgentRunner, type FabricHostedReporter } from "../../src/runners.js";

interface Backend {
  /** Every answer a reporter delivered, with the resident host process that delivered it. */
  answers: Array<{ pid: number; answer: unknown }>;
}

const backendFile = (job: string): string => {
  const directory = process.env.FABRIC_TEST_HOSTED_BACKEND;
  if (!directory) throw new Error("FABRIC_TEST_HOSTED_BACKEND is not set");
  return path.join(directory, `${job}.json`);
};

const load = (job: string): Backend =>
  JSON.parse(fs.readFileSync(backendFile(job), "utf8")) as Backend;

const save = (job: string, backend: Backend): void => {
  const file = backendFile(job);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(backend));
  fs.renameSync(`${file}.tmp`, file);
};

const ask = (job: string, reporter: FabricHostedReporter): void => {
  void reporter
    .question({ method: "select", title: "Pick a colour", options: ["red", "blue"] })
    .then((answer) => {
      const backend = load(job);
      backend.answers.push({ pid: process.pid, answer });
      save(job, backend);
      reporter.finish({ status: "completed", output: JSON.stringify(answer) });
    });
};

const jobOf = (locator: unknown): string => (locator as { job: string }).job;

registerAgentRunner({
  kind: "hosted",
  id: "restart-asker",
  label: "Restart asker",
  capabilities: {
    recursiveFabric: false,
    steer: false,
    followUp: false,
    persistentSessions: false,
    kernels: false,
    handoff: false,
    modelDiscovery: false,
    imageInput: false,
    compaction: false,
    questions: true,
    sleep: false,
    writePolicy: false,
  },
  prepare: (context) => ({ job: context.idempotencyKey }),
  start(locator, _context, reporter) {
    save(jobOf(locator), { answers: [] });
    ask(jobOf(locator), reporter);
  },
  attach(locator, _context, reporter) {
    const [answered] = load(jobOf(locator)).answers;
    if (answered) reporter.finish({ status: "completed", output: JSON.stringify(answered.answer) });
    else ask(jobOf(locator), reporter);
  },
  liveness: () => "running",
  stop: () => ({ confirmed: true }),
});
