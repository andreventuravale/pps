#!/usr/bin/env ts-node

import { spawn } from 'child_process'
import fs from 'fs/promises'
import yaml from 'js-yaml'
import { isEmpty } from 'lodash'
import { join, resolve } from 'path'
import puppeteer, { Browser, ElementHandle, Page, PuppeteerLifeCycleEvent, Target } from 'puppeteer'
import readline from 'readline'
import { Readable } from 'stream'
import { promisify } from 'util'

const kc = require('keychain')

const gp = promisify(kc.getPassword).bind(kc)
const sp = promisify(kc.setPassword).bind(kc)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const question = promisify(rl.question).bind(rl) as unknown as (question: string) => Promise<string>

type url = string

type Selector = string | { text: string }

type CaptureClipboardStatement = ['capture-clipboard', string]
type ClearStatement = ['clear', string]
type ClickStatement = ['click', string | undefined]
type FocusStatement = ['focus', string]
type OpenStatement = ['open', url]
type PasswordStatement = ['password', { account: string, service: string, name: string }]
type ReadStatement = ['read', { question: string, name: string }]
type SleepStatement = ['sleep', number]
type TypeStatement = ['type', string | { name: string }]
type WaitNavStatement = ['wait-navigation', PuppeteerLifeCycleEvent | undefined]
type WaitNewTargetStatement = ['wait-new-target', string]
type WaitStatement = ['wait', Selector | Selector[]]

type Statement =
  | CaptureClipboardStatement
  | ClearStatement
  | ClickStatement
  | FocusStatement
  | OpenStatement
  | PasswordStatement
  | ReadStatement
  | SleepStatement
  | TypeStatement
  | WaitNavStatement
  | WaitNewTargetStatement
  | WaitStatement

type Keyword = Statement[0]

type Script = Statement[]

type Query = ElementHandle<Element> | null

type Context = {
  browser: Browser
  output: Record<string, string>
  pages: Page[]
  query?: Query
  targets: Target[]
  vars: Record<string, string>
}

type Handler<S extends Statement = any> = (statement: S, context: Context) => Promise<void>

const handlers: Record<Keyword, Handler> = {
  'capture-clipboard': async (statement: CaptureClipboardStatement, context) => {
    const bc = await context.browser.defaultBrowserContext()

    const url = new URL(context.pages[0].url())

    await bc.overridePermissions(url.origin, ['clipboard-write', 'clipboard-read'])

    const copiedText = (await context.pages[0].evaluate(`(async () => await navigator.clipboard.readText())()`)) as string

    const key = statement[1]

    context.output[key] = copiedText
  },
  clear: async (statement: ClearStatement, context) => {
    await context.pages[0].evaluate((sel: string) => {
      const el = document.querySelector<HTMLInputElement>(sel) ?? undefined
      el && (el.value = '')
    }, statement[1])
  },
  click: async (statement: ClickStatement, context) => {
    if (typeof statement[1] === 'string') {
      await context.pages[0].click(statement[1])
    } else {
      await context.query?.click()
    }
  },
  focus: async (statement: FocusStatement, context) => {
    await context.pages[0].focus(statement[1])
  },
  open: async ([, url]: OpenStatement, context) => {
    context.pages.unshift(await context.browser.newPage())

    context.targets.unshift(context.pages[0].target())

    await context.pages[0].goto(url, { waitUntil: 'networkidle0' })
  },
  password: async ([, { account, service, name }]: PasswordStatement, context) => {
    try {
      const password = await gp({ account, service, type: 'internet' })

      context.vars[name] = password
    } catch (err: any) {
      if (!isEmpty(err) && err.code !== 'PasswordNotFound') {
        throw err
      }

      const answer = await question('Enter the password: ')

      await sp({ account, service, type: 'internet', password: answer })

      context.vars[name] = answer
    }
  },
  read: async (statement: ReadStatement, context) => {
    const value = await context.pages[0].evaluate(question => {
      return window.prompt(question)
    }, statement[1].question) as string

    context.vars[statement[1].name] = value
  },
  sleep: async (statement: SleepStatement, context) => {
    await context.pages[0].waitForTimeout(statement[1] * 1000)
  },
  type: async (statement: TypeStatement, context) => {
    if (typeof statement[1] === 'string') {
      await context.query?.type(statement[1])
    } else {
      await context.query?.type(context.vars[statement[1].name])
    }
  },
  wait: async (statement: WaitStatement, context) => {
    if (typeof statement[1] === 'string') {
      context.query = await context.pages[0].waitForSelector(statement[1], { visible: true })
    } else {
      if ('text' in statement[1]) {
        context.query = await context.pages[0].waitForXPath(`//*[contains(.,'${(statement[1] as any).text}')]`, { visible: true }) as any
      }
    }
  },
  'wait-navigation': async ([, waitUntil = 'networkidle0']: WaitNavStatement, context) => {
    await context.pages[0].waitForNavigation({
      waitUntil
    })
  },
  'wait-new-target': async (statement: WaitNewTargetStatement, context) => {
    const target = await context.browser.waitForTarget(async target => (await (await target.page())?.title()) === statement[1])

    const page = await target.page()

    if (page === null) {
      throw new Error('page is null')
    }

    await page.bringToFront()

    context.pages.unshift(page)

    context.targets.unshift(target)

    page.on('close', () => {
      const index = context.pages.indexOf(page)

      context.targets.splice(index, 1)

      context.pages.splice(index, 1)
    })
  }
}

async function run() {
  const inputPath = resolve(join(process.cwd(), process.argv[2]))

  const input = await fs.readFile(inputPath, 'utf-8')

  const source = yaml.load(input) as object[]

  const script = source
    .flatMap(
      statement =>
        typeof statement === 'string'
          ? [[statement]] as any
          : Object.entries(statement)
    ) as Script

  let line = 1

  const context: Context = {
    browser: await puppeteer.launch({ headless: false }),
    output: {},
    pages: [],
    targets: [],
    vars: {}
  }

  for (const statement of script) {
    const keyword = statement[0]

    if (!(keyword in handlers)) {
      throw new Error(`(line=${line} statement=${JSON.stringify(statement)}) Keyword not implemented: ${keyword}.`)
    }

    console.group(`(line=${line}) ${JSON.stringify(statement)}`)

    try {
      await handlers[statement[0]](statement, context)
    } catch (error: any) {
      console.log(`Error: ${error.message}`)
    } finally {
      console.groupEnd()
    }

    line++
  }

  await context.browser.close()

  const output = spawn('ts-node', ['output.ts'], { cwd: process.cwd(), stdio: 'pipe' })

  output.on('exit', code => {
    process.exit(code ?? 0)
  })

  Readable.from(JSON.stringify(context.output)).pipe(output.stdin)
}

run().catch(error => {
  console.error(error)

  process.exit(1)
})
