import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { parseCsv } from '../../proof/score'

const SCORE = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../proof/score.ts')

// A filled sheet as a spreadsheet saves it: BOM, CRLF, quoted fields, odd case and spaces in labels.
const SHEET =
  '﻿session_id,agent_id,group,timestamp,position,tool_use_id,rule,pattern,label\r\n' +
  's1,,main,2026-09-01T10:00:00Z,2,toolu_a,no-risky-commands,git push --force,real\r\n' +
  's1,,main,2026-09-01T10:01:00Z,3,toolu_b,no-risky-commands,git reset --hard, False \r\n' +
  's2,,main,2026-09-02T10:00:00Z,1,toolu_c,no-risky-commands,"DROP TABLE/DATABASE",false\r\n' +
  's2,,main,2026-09-02T10:01:00Z,4,toolu_d,no-risky-commands,git push --force,unsure\r\n' +
  's3,,main,2026-09-03T10:00:00Z,1,toolu_e,no-secrets-in-files,"password literal; .env-style line",REAL\r\n' +
  's3,,main,2026-09-03T10:02:00Z,2,toolu_f,no-secrets-in-files,password literal,\r\n' +
  's3,,main,2026-09-03T10:03:00Z,3,toolu_g,no-outside-edits,outside project,maybe\r\n' +
  's4,,self,2026-09-04T10:00:00Z,1,toolu_h,no-risky-commands,git reset --hard,false\r\n'

let dir: string
let stdout: string
let result: any
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'c-check-score-'))
  writeFileSync(join(dir, 'label-sheet.csv'), SHEET)
  stdout = execFileSync(process.execPath, [SCORE, join(dir, 'label-sheet.csv'), '--json', join(dir, 'score.json')], { encoding: 'utf8' })
  result = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('proof: score a filled label sheet', () => {
  test('counts per rule, with unsure left out of the false alarm rate', () => {
    expect(result.main['no-risky-commands']).toEqual({ fires: 4, real: 1, false: 2, unsure: 1, unlabeled: 0, invalid: 0, falseAlarmRate: 2 / 3 })
    expect(result.main['no-secrets-in-files']).toEqual({ fires: 2, real: 1, false: 0, unsure: 0, unlabeled: 1, invalid: 0, falseAlarmRate: 0 })
    expect(result.main['no-outside-edits']).toEqual({ fires: 1, real: 0, false: 0, unsure: 0, unlabeled: 0, invalid: 1, falseAlarmRate: null })
  })

  test('group "self" is scored apart', () => {
    expect(result.self).toEqual({ 'no-risky-commands': { fires: 1, real: 0, false: 1, unsure: 0, unlabeled: 0, invalid: 0, falseAlarmRate: 1 } })
    expect(result.main['no-risky-commands'].fires).toBe(4)
  })

  test('the report shows unsure, unlabeled and bad labels on their own lines', () => {
    expect(stdout).toContain('| no-risky-commands | 4 | 1 | 2 | 2/3 (')
    expect(stdout).toContain('- no-risky-commands: 1 unsure (left out of the rate)')
    expect(stdout).toContain('- no-secrets-in-files: 1 not labeled yet (left out of the rate)')
    expect(stdout).toContain('- no-outside-edits: 1 with a label other than real, false or unsure (left out of the rate)')
    expect(stdout).toContain('| no-outside-edits | 1 | 0 | 0 | 0/0 (n/a) |')
  })

  test('the CSV reader keeps quoted commas and doubled quotes', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']])
  })
})
