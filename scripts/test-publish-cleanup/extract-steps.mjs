// Pulls the shell out of the publish workflow's two Hub-cleanup steps so
// run.sh can execute them against a stubbed API.
//
// The scripts are re-extracted on every run, so what the test exercises is
// always the current contents of the workflow — there is no checked-in copy to
// drift. The one way that could silently stop testing anything is a renamed
// step, so a missing name is a hard failure that lists what was actually found.

import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

const WORKFLOW = '.github/workflows/docker-publish.yml';

// Step name -> basename of the script run.sh invokes.
const STEPS_UNDER_TEST = {
  'Record the digests these tags point at today': 'record',
  'Delete the manifests this publish superseded': 'delete',
};

const [outputDir] = process.argv.slice(2);
if (!outputDir) {
  console.error('usage: extract-steps.mjs <output-dir>');
  process.exit(1);
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflow = parse(fs.readFileSync(path.join(repoRoot, WORKFLOW), 'utf8'));

const allSteps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
const named = new Map(allSteps.filter(step => step.name && step.run).map(step => [step.name, step.run]));

fs.mkdirSync(outputDir, { recursive: true });

const missing = [];
for (const [stepName, basename] of Object.entries(STEPS_UNDER_TEST)) {
  const script = named.get(stepName);
  if (script === undefined) {
    missing.push(stepName);
    continue;
  }
  fs.writeFileSync(path.join(outputDir, `${basename}.sh`), script);
}

if (missing.length > 0) {
  console.error(`Could not find these steps in ${WORKFLOW}:`);
  missing.forEach(name => console.error(`  - ${name}`));
  console.error('\nSteps with a run block in that workflow:');
  [...named.keys()].forEach(name => console.error(`  - ${name}`));
  console.error('\nRename them back, or update STEPS_UNDER_TEST in this file.');
  process.exit(1);
}
