
import fs from "fs/promises";
import yaml from "js-yaml";
import ora from "ora";

type URL = string

type Expr = string

type ClickStatement = ['click']
type OpenStatement = ['open', URL]
type WaitStatement = ['wait', Expr]

type Statement =
  | OpenStatement
  | ClickStatement
  | WaitStatement

type Keyword = Statement[0]

type Script = Statement[]

type Handler = (script: Script, statement: Statement) => Promise<void>

const handlers: Record<Keyword, Handler> = {
  open: async (script, statement) => {
    const spinner = ora()
    spinner.start(JSON.stringify(statement))
    try {
      spinner.succeed()
    } catch (error: any) {
      spinner.fail(error.message)
    }
  },
  click: async (script, statement) => {
  },
  wait: async (script, statement) => {
  }
}

async function run() {
  const input = await fs.readFile(`${__dirname}/input.yaml`, 'utf-8')

  const source = yaml.load(input) as object[]

  const script = source
    .flatMap(
      statement =>
        typeof statement === 'string'
          ? [[statement]] as any
          : Object.entries(statement)
    ) as Script

  console.log(input, source, script)

  let line = 1

  for (const statement of script) {
    const keyword = statement[0]
    console.log(keyword)
    if (!(keyword in handlers)) {
      throw new Error(`(line=${line} statement=${JSON.stringify(statement)}) Keyword not implemented: ${keyword}.`)
    }
    handlers[statement[0]](script, statement)
    line++
  }
}

run().catch(error => {
  console.error(error)

  process.exit(1)
})
