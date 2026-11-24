const http = require('node:http')
const https = require('node:https')
const path = require('node:path')
const fs = require('node:fs')
const {fault,WECHAT_TEST_MODE} = require('./store-rules')
const {createWechatIdentity} = require('./wechat-identity')
const {notificationDetails,prepareInvite,readInvite,sendSms} = require('./notifications')

const assets = path.join(__dirname,'public')
const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'}
const actions = new Set(['bootstrap','bindStaffName','setServicePhone','board','orders','storeOrders','order','save','cancel','arrive','settle','customer','customerLookup','customerInsights','report','configure','import','staffSave','staffList','staffRoles','setStaffRole','setStaffProfile'])
const codes = {UNAUTHORIZED:401,AUTH_FAILED:401,FORBIDDEN:403,NAME_REQUIRED:403,ACCESS_PENDING:403,NOT_FOUND:404,GONE:410,TABLE_CONFLICT:409,VERSION_CONFLICT:409,NOTIFY_PENDING:409,ADMIN_BOUND:409,RATE_LIMIT:429,SMS_UNCONFIGURED:503,SMS_FAILED:502,VALIDATION:400}
const disabledSmsEnv = Object.freeze(Object.create(null))

async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 512 * 1024) throw fault('VALIDATION','请求过大，请分批处理')
    chunks.push(chunk)
  }
  try {
    const obj = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (!obj || Array.isArray(obj) || typeof obj !== 'object') throw Error()
    return obj
  } catch {
    throw fault('VALIDATION','请求格式无效')
  }
}

function createServer(store, options = {}) {
  const wechatTest = store.environment === WECHAT_TEST_MODE
  const wechatIdentity = wechatTest && createWechatIdentity(options.wechatEnv)
  const smsEnv = wechatTest ? disabledSmsEnv : options.smsEnv
  const attempts = new Map()
  const handleRequest = async (req,res) => {
    const json = (status,obj) => {
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'})
      res.end(JSON.stringify(obj))
    }
    res.setHeader('Cache-Control','no-store')
    res.setHeader('X-Content-Type-Options','nosniff')
    res.setHeader('Referrer-Policy','no-referrer')
    try {
      const url = new URL(req.url,'http://localhost')
      const route = url.pathname
      if (req.method === 'GET' && route === '/health') {
        if (store.storage !== 'mysql') return json(200,{ok:true})
        const ok = await store.checkHealth().catch(() => false)
        const result = {ok,service:'shh-booking',storage:'mysql'}
        if (wechatTest) {
          let identityAvailable = false
          try { identityAvailable = Boolean(wechatIdentity(req.headers)) } catch {}
          Object.assign(result,{trial:true,auth:'wechat',environment:WECHAT_TEST_MODE,wechatIdentity:identityAvailable})
        }
        return json(ok ? 200 : 503,result)
      }
      if (wechatTest && req.method === 'POST' && route === '/auth/wechat') {
        const identity = wechatIdentity(req.headers)
        await readJson(req)
        return json(200,await store.loginWechat(identity))
      }
      if (wechatTest && req.method === 'POST' && route === '/auth/wechat/bind-admin') {
        const identity = wechatIdentity(req.headers)
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'')
        const { password } = await readJson(req)
        if (typeof password !== 'string' || !password || password.length > 128) throw fault('VALIDATION','请填写管理员绑定口令')
        return json(200,await store.bindWechatAdmin(identity,token,password))
      }
      if (!wechatTest && req.method === 'POST' && route === '/auth/login') {
        const data = await readJson(req)
        if (typeof data.staffId !== 'string' || data.staffId.length > 40 || typeof data.password !== 'string' || data.password.length > 128) throw fault('AUTH_FAILED','员工账号或密码无效')
        const key = req.socket.remoteAddress
        const now = Date.now()
        const recent = (attempts.get(key) || []).filter(t=>t>now-600000)
        if (recent.length >= 25) throw fault('RATE_LIMIT','尝试次数过多，请稍后登录')
        attempts.set(key,recent.concat(now))
        const login = await store.login(data.staffId,data.password)
        attempts.delete(key)
        return json(200,login)
      }
      if (req.method === 'GET' && route.startsWith('/invite/')) return json(200,await readInvite(store,route.slice(8)))
      if (route.startsWith('/api/') || route === '/auth/logout') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'')
        const staffId = await store.authenticate(token,wechatTest ? wechatIdentity(req.headers) : undefined)
        if (route === '/auth/logout' && req.method === 'POST') {
          await store.logout(token)
          return json(200,{ok:true})
        }
        const action = route.slice(5)
        if (action === 'export' && req.method === 'GET') {
          const {searchParams} = url
          const report = await store.run(staffId,'report',{date:searchParams.get('date'),period:searchParams.get('period') ?? undefined},token)
          const bytes = require('./export').buildWorkbook(report)
          const filename = report.period === 'month' ? 'monthly-report.xlsx' : 'daily-report.xlsx'
          res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${filename}"`})
          return res.end(bytes)
        }
        if (req.method !== 'POST') throw fault('NOT_FOUND','接口不存在')
        const input = await readJson(req)
        if (action === 'notificationDetails') return json(200,await notificationDetails(store,staffId,input.id,smsEnv,token))
        if (action === 'prepareInvite') return json(200,await prepareInvite(store,staffId,input.id,smsEnv,token))
        if (action === 'notifySms') return json(200,await sendSms(store,staffId,input.id,smsEnv,options.smsTransport,input.version,token))
        if (!actions.has(action)) throw fault('NOT_FOUND','接口不存在')
        return json(200,await store.run(staffId,action,input,token))
      }
      if (wechatTest || req.method !== 'GET' || (route !== '/' && !/^\/[a-zA-Z0-9_.-]+\.(html|js|css|svg|png|ico)$/.test(route))) throw fault('NOT_FOUND','页面不存在')
      const p = path.join(assets,route === '/' ? 'index.html' : route.slice(1))
      if (!fs.existsSync(p)) throw fault('NOT_FOUND','页面不存在')
      res.writeHead(200,{'Content-Type':types[path.extname(p)]})
      res.end(fs.readFileSync(p))
    } catch (err) {
      const status = codes[err.code]
      if (!status) console.error('门店接口异常',err.name,err.code || '')
      json(status || 500,{code:status ? err.code : 'INTERNAL',error:status ? err.message : '门店服务暂时无法完成操作',
        ...(Array.isArray(err.tableIds) ? {tableIds:err.tableIds} : {}), ...(err.row ? {row:err.row} : {})})
    }
  }
  return options.tls ? https.createServer(options.tls,handleRequest) : http.createServer(handleRequest)
}

async function start() {
  if (process.argv.length > 2) throw Error('门店服务通过环境变量配置启动模式')
  const {TLS_CERT_FILE, TLS_KEY_FILE, STORE_BACKEND = 'sqlite', STORE_MODE = 'production'} = process.env
  if (Boolean(TLS_CERT_FILE) !== Boolean(TLS_KEY_FILE)) throw Error('HTTPS 需要同时指定证书链和私钥文件')
  const tls = TLS_CERT_FILE ? {
    cert:fs.readFileSync(TLS_CERT_FILE), key:fs.readFileSync(TLS_KEY_FILE), minVersion:'TLSv1.2'
  } : undefined
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT || 8787)
  if (STORE_BACKEND === 'mysql') {
    if (STORE_MODE === WECHAT_TEST_MODE) createWechatIdentity()
    const store = await require('./mysql-store').openMysqlStore()
    createServer(store,{tls}).listen(port,host,()=>{
      console.log('门店后台 '+(tls?'https':'http')+'://'+host+':'+port+'，使用 MySQL')
    })
    return
  }
  if (STORE_BACKEND !== 'sqlite') throw Error('STORE_BACKEND 须为 sqlite 或 mysql')
  if (STORE_MODE !== 'production') throw Error('微信测试门店须使用 MySQL')

  const {openStore} = require('./database')
  const directory = process.env.STORE_DATA_DIR || path.join(__dirname,'..','.runtime','store')
  const store = openStore(directory,{adminPassword:process.env.STORE_ADMIN_PASSWORD})
  createServer(store,{tls}).listen(port,host,()=>{
    console.log('门店后台 '+(tls?'https':'http')+'://'+host+':'+port+'，数据目录 '+directory)
  })
}

if (require.main === module) start().catch(err => {
  console.error('门店服务启动失败', err.message)
  process.exitCode = 1
})

module.exports = {createServer}
