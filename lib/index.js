const path = require('path')
const https = require('https')
const WebSocket = require('ws')
const Util = require('./util')
const ChromeWrapper = require('./chrome')
const AWS = require('aws-sdk')
const S3Sync = require('./s3-sync')
const Journal = require('./journal')

require('sugar').extend()

// load the config with some defaults
let config = require(path.join(process.cwd(), process.argv[2]))
let appRoot = path.resolve(process.cwd(), config.appRoot || '')
let port = config.port || 3100
let testDependencies = config.testDependencies || []
config.s3Url = `https://s3-${config.aws.region}.amazonaws.com/${config.aws.assetBucket}/${config.aws.assetPrefix}/index.html`
config.lambdaConcurrency = config.lambdaConcurrency || 400
config.htmlTemplate = config.htmlTemplate || '<body>ZEN_SCRIPTS</body>'

// tmpDir is where we cache files between runs
config.tmpDir = config.tmpDir || path.join(appRoot, '.zen')
Util.ensureDir(config.tmpDir)
console.log('Using tmpDir', config.tmpDir)

let runId = 1
let grep = null
let compile = {status: 'compiling'}
let head = null
let workers = Array.construct(8, id => ({id: id + 1}))
let lambdaCount = 0
let workingSet = []
let remaining = []
let results = [] // results of all tests run
let passedFocus = [] // all tests that passed after running
let journal = new Journal(config)

AWS.config.update(config.aws)
let s3Sync = new S3Sync(config, sendStatus)
let lambda = new AWS.Lambda()
https.globalAgent.maxSockets = 2000 // TODO multiplex over fewer connections

// start up the local webserver for `head` to connect to
let app = require('connect')()
let server = require('http').createServer(app).listen(port)
app.use('/lib', Util.serveWith404(__dirname)) // serve up stuff out of lib
app.use('/node_modules', Util.serveWith404(path.resolve(__dirname, '../node_modules'))) // serve up stuff out of lib
app.use('/base', Util.serveWith404(appRoot)) // base serves things out of the application's root
app.use('/svelte', Util.serveSvelte)
app.use('/icons', Util.serveIcons)

// create a server for each worker. This gives us different origins and isolates things like localStorage
workers.forEach((w, idx) => {
  w.port = port + w.id
  require('http').createServer(app).listen(w.port)
})

// boot up webpack (if configured)
config.webpack && require('./webpack')(config, app, (stats) => {
  compile = stats
  if (stats.status == 'done') {
    workers.forEach(w => w.tab && w.tab.setCodeHash(stats.hash))
  }
  sendStatus() // notify head of the compile status
})

// host worker and head
app.use(async (req, resp) => {
  resp.end(indexHtml(req.url.match(/^\/worker/) ? 'worker' : 'head'))
})

let chrome = new ChromeWrapper(config) // headless chrome instance
chrome.launch({port: 9222})
workers.forEach(w => chrome.openTab(`http://localhost:${w.port}/worker?id=${w.id}`, `w${w.id}`).then(t => w.tab = t))

new WebSocket.Server({server}).on('connection', function connection(ws, req) {
  head = ws
  ws.on('message', msg => {
    msg = JSON.parse(msg)
    if (msg.type === 'run') run(msg)
    if (msg.type === 'passedFocus') passedFocus.push(msg.test)
    sendStatus()
  })
  ws.on('error', err => {
    console.error('Websocket error', err)
    head = null
  })
  sendStatus()
})

function run(msg) {
  if (msg.reload)
    workers.forEach(w => w.tab.reload())

  if (msg.filterFailed) { // filter down to the tests that failed in the last full run
    workingSet = results.filter(r => r.error).map(r => r.fullName)

  // if the user changed (but didn't clear) grep, or sent `force`, we should run tests
  } else if (msg.testNames && ((msg.grep != grep && msg.grep) || msg.force)) {
    workingSet = msg.testNames
    grep = msg.grep

  } else // nothing to do. Probably a page load that didn't change the grep
    return

  if (compile.status != 'done')
    return // stop for now if the code isn't ready

  results = []
  passedFocus = []
  runId++
  lambdaCount = 0
  remaining = workingSet.clone()

  if (!grep) // should this be if the tests will take longer than x seconds?
    runOnLambda()
  else
    workers.forEach(w => runWorker(w, runId))
}

async function runOnLambda() {
  let runGroups = []
  let byTime = workingSet.sortBy(name => -journal.guessRuntime(name))
  byTime.forEach(fullName => {
    let min = runGroups[0]
    let time = journal.guessRuntime(fullName)
    let newTime = min ? min.time + time : time

    // Assign tests to whichever group has the lowest total time.
    // Groups can grow to about 500ms before we create a new one, and never create more
    // than the concurrency limit.
    if ((!min || newTime > 500) && runGroups.length < config.lambdaConcurrency)
      min = {tests: [], time: 0}
    else
      runGroups.shift()

    min.tests.push(fullName)
    min.time += time

    // sorted insert into runGroups
    let pos = runGroups.findIndex(g => g.time > min.time)
    if (pos >= 0)
      runGroups.splice(pos, 0, min)
    else
      runGroups.push(min)
  })

  lambdaCount = runGroups.length
  await s3Sync.run({compile, indexHtml: indexHtml('worker', true)})

  runGroups.forEach(async (group, groupIndex) => {
    let url = config.s3Url + `?id=L${groupIndex}` // give each lambda worker an id so the sessionId is useful
    let tStart = new Date()
    let response = await Util.invoke(lambda, 'serverless-zen-dev-workTests', {url, testNames: group.tests, runId})

    if (response.errorMessage) {
      console.error('Error while runnning', group)
      console.error(response.errorMessage)
      onResults(group.tests.map((fullName, testNumber) => {
        return {runId, error: response.errorMessage, fullName, sessionId: groupIndex, testNumber}
      }))
      return
    }

    if (response.body[0].runId != runId) return
    if (response.body.find(r => r.error))
      console.log(group)

    onResults(response.body)
  })
}

async function runWorker(w, startingRunId) {
  while (remaining.length > 0) {
    let result = await w.tab.setTest({runId: startingRunId, testName: remaining.pop()})
    if (!result || result.runId !== runId) break // if the run was aborted
    onResults([result])
  }
}

function onResults(step) {
  results.push.apply(results, step)
  step.forEach(r => journal.record(r))
  Util.wsSend(head, {results: step})
}

function sendStatus() {
  Util.wsSend(head, {
    results, runId, lambdaCount, passedFocus,
    workingSetLength: workingSet.length,
    s3: s3Sync.status,
    compile: Object.select(compile, ['hash', 'status', 'errors', 'percentage', 'message']) // exclude files array, which has contains content
  })
}

function indexHtml(pageType, forS3) {
  let deps = ['lib/latte.js']
  if (pageType == 'head') {
    deps.unshift('icons')
    deps.push('node_modules/svelte/store.umd.js', 'node_modules/fuzzysort/fuzzysort.js', 'svelte/mini.js', 'svelte/command.js')
  }
  deps.push(`lib/${pageType}.js`) // after Zen dependencies, but before user code
  let entries = (compile && compile.entrypoints) || []

  if (forS3) {
    deps.push((config.alsoServe || []).map(as => as.addToIndex && path.basename(as.filePath)))
    deps.push(entries.map(e => `webpack/${e}`))
  } else {
    deps.push(testDependencies.map(t => t.replace(appRoot, '/base')))
    deps.push(entries.map(e => `//localhost:3100/webpack/${e}`))
  }

  let scripts = deps.flatten().compact(true).map(d => `<script src='${d}'></script>`)

  scripts.unshift(`<script>
    window.Zen = {config: ${JSON.stringify(config)}}
  </script>`)

  return config.htmlTemplate.replace('ZEN_SCRIPTS', scripts.join('\n'))
}

global.Zen = {head, workers}
