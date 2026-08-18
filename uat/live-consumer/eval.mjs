import fs from 'node:fs'

const expectedOldModel = ['claude', '3', '5', 'sonnet', '20241022'].join('-')
const expectedNewModel = ['claude', 'sonnet', '4', '6'].join('-')
const expectedFile = 'uat/live-consumer/client.mjs'

if (process.env.MODEL_EOL_OLD_ID !== expectedOldModel || process.env.MODEL_EOL_NEW_ID !== expectedNewModel) {
  throw new Error('migration identity environment did not match the selected model')
}

if (!process.env.MODEL_EOL_PLAN || !process.env.MODEL_EOL_REPORT) {
  throw new Error('migration plan and report paths are required')
}

const selectedPlan = JSON.parse(fs.readFileSync(process.env.MODEL_EOL_PLAN, 'utf8'))
if (
  selectedPlan.items?.length !== 1 ||
  selectedPlan.items[0].file !== expectedFile ||
  selectedPlan.items[0].replacement !== expectedNewModel
) {
  throw new Error('expected one isolated migration item')
}

const clientSource = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8')
if (clientSource.includes(expectedOldModel) || !clientSource.includes(expectedNewModel)) {
  throw new Error('isolated checkout does not contain the expected migration')
}

fs.writeFileSync(
  process.env.MODEL_EOL_REPORT,
  `Verified isolated migration from ${expectedOldModel} to ${expectedNewModel}.\n`,
)
