import type { Rule } from '../engine/types'
import { claimedChangesAreReal } from './claimed-changes-are-real'
import { deployGate } from './deploy-gate'
import { judgeSpecialCases } from './judge-special-cases'
import { noDataBeforeLogin } from './no-data-before-login'
import { noOutsideEdits } from './no-outside-edits'
import { noRiskyCommands } from './no-risky-commands'
import { noSecretsInFiles } from './no-secrets-in-files'
import { noTestBloat } from './no-test-bloat'
import { noTestWeakening } from './no-test-weakening'
import { testsPassBeforeDone } from './tests-pass-before-done'
import { testsStillBite } from './tests-still-bite'

// R1 and R6 always ship together: R1 is not safe without its partner.
export const RULES: readonly Rule[] = [
  testsPassBeforeDone,
  noOutsideEdits,
  noRiskyCommands,
  noSecretsInFiles,
  claimedChangesAreReal,
  noTestWeakening,
  noTestBloat,
  testsStillBite,
  judgeSpecialCases,
  noDataBeforeLogin,
  deployGate,
]
