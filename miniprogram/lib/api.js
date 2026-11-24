const { today } = require('./domain')
const { cloudRun } = require('../config')

const accessPage = '/pages/access/index'
const cloudTimeout = 15000
const serviceIdleLimit = 5 * 60 * 1000
const healthRetryTimes = [6000, 18000, 36000]
const temporaryStatuses = new Set([502, 503, 504])
const configurationCodes = new Set([40097, 102005, 501005, 601027, 601031, 601034, 606001, 606002, 606003, 606006])
const cloudStages = { init: '微信云托管初始化', health: '门店健康检查', login: '微信登录', request: '门店请求' }
const storeErrorStatuses = {
  UNAUTHORIZED: 401, AUTH_FAILED: 401, FORBIDDEN: 403, NAME_REQUIRED: 403, ACCESS_PENDING: 403,
  NOT_FOUND: 404, GONE: 410, TABLE_CONFLICT: 409, VERSION_CONFLICT: 409, NOTIFY_PENDING: 409,
  ADMIN_BOUND: 409, RATE_LIMIT: 429, VALIDATION: 400, INTERNAL: 500, SMS_FAILED: 502, SMS_UNCONFIGURED: 503,
}
const configurationReasons = [
  /\b(?:permission|forbidden|unauthori[sz]ed|authorization mismatch|access denied|domain list|invalid app\s?id)\b/i,
  /\b(?:env(?:ironment)?|service(?:name)?)\b.{0,48}\b(?:not found|not exists?|does not exist|invalid|mismatch)\b/i,
  /\b(?:invalid|wrong) (?:env(?:ironment)?|service(?:name)?)\b|权限|未授权|未开通|(?:环境|服务).{0,16}(?:不存在|未配置|错误|不匹配)/i,
]
const offlineReasons = [
  /\b(?:offline|no (?:network|internet)|not connected to (?:the )?internet|network (?:is )?(?:disconnected|unreachable|down))\b/i,
  /\b(?:ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_UNREACHABLE)\b|断网|离线|无网络|没有网络|网络未连接|网络不可用/i,
]
const temporaryReasons = [
  /\b(?:time(?:d)?[\s_-]?out|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT|network (?:error|failure|changed|request failed))\b/i,
  /\b(?:connection reset|ECONNRESET|ERR_NETWORK_CHANGED|service[_ -]not[_ -]ready|cold[_ -]start(?:ing)?|temporarily unavailable)\b/i,
  /请求超时|网络(?:异常|错误|超时|波动|连接失败)|连接(?:超时|重置)|(?:服务|容器)(?:正在)?(?:启动|冷启动)|冷启动中/,
]
let cloudInitialization
let serviceVerification
let verifiedServiceActivityAt
let loginRequest
let sessionToken = ''
let openingAccess = false

function serviceError(code, message, details) {
  return Object.assign(new Error(message), { code }, details)
}

function connectionError(stage, code, hint, { wechatCode, statusCode, temporary = false } = {}) {
  const reference = wechatCode !== undefined ? '微信错误码 ' + wechatCode : statusCode ? 'HTTP ' + statusCode : ''
  return serviceError(code, cloudStages[stage] + '失败，' + hint + (reference ? '（' + reference + '）' : ''), {
    stage, wechatCode, statusCode, temporary,
  })
}

function wechatErrorNumber(value) {
  if (typeof value === 'string' && /^-?\d{1,6}$/.test(value)) value = Number(value)
  if (Number.isInteger(value) && Math.abs(value) <= 999999) return value
}

function httpStatus(value) {
  if (Number.isInteger(value) && value >= 100 && value <= 599) return value
}

function cloudFailure(stage, error) {
  const reason = typeof error === 'string' ? error : [error?.errMsg, error?.message, error?.code]
    .filter(value => typeof value === 'string').join(' ')
  const embeddedCode = reason.match(/\b(?:errcode|errno)\s*[:=]\s*(-?\d+)(?=$|[\s|,;\])])/i)?.[1]
  const wechatCode = [error?.errCode, error?.errcode, error?.errno, error?.code, embeddedCode, error]
    .map(wechatErrorNumber).find(value => value !== undefined)
  const statusCode = httpStatus(error?.statusCode)
  const diagnostics = { wechatCode, statusCode }
  if ([401, 403, 404].includes(statusCode) || configurationCodes.has(Math.abs(wechatCode)) ||
      configurationReasons.some(pattern => pattern.test(reason))) {
    return connectionError(stage, 'CONFIG', '请联系管理员核对微信云托管权限和配置', diagnostics)
  }
  if (offlineReasons.some(pattern => pattern.test(reason))) {
    return connectionError(stage, 'NETWORK', '请连接网络后重试', diagnostics)
  }
  const temporary = Math.abs(wechatCode) === 102002 || temporaryStatuses.has(statusCode) ||
    temporaryReasons.some(pattern => pattern.test(reason))
  return connectionError(stage, 'NETWORK', '请检查网络后重试', { ...diagnostics, temporary })
}

function initializeCloud() {
  if (cloudInitialization) return cloudInitialization
  let version
  try { version = wx.getAccountInfoSync().miniProgram.envVersion } catch (_) {}
  if (version !== 'develop' && version !== 'trial') {
    throw connectionError('init', 'CONFIG', '请使用小程序的体验版进入测试门店')
  }
  if (!cloudRun?.env || !cloudRun?.service) {
    throw connectionError('init', 'CONFIG', '请联系管理员配置测试门店的微信云托管环境和服务')
  }
  if (typeof wx.cloud?.init !== 'function') {
    throw connectionError('init', 'CONFIG', '请更新微信后重试')
  }
  cloudInitialization = Promise.resolve().then(async () => {
    try {
      await wx.cloud.init({ env: cloudRun.env })
    } catch (error) {
      throw cloudFailure('init', error)
    }
    if (typeof wx.cloud?.callContainer !== 'function') {
      throw connectionError('init', 'CONFIG', '请更新微信后重试')
    }
  }).catch(error => {
    cloudInitialization = undefined
    throw error
  })
  return cloudInitialization
}

function healthIdentityError(result, statusCode) {
  if (result?.service !== 'shh-booking' || result.storage !== 'mysql' || result.trial !== true ||
      result.auth !== 'wechat' || result.environment !== 'wechat-test' || (statusCode < 300 && result.ok !== true)) {
    return connectionError('health', 'CONFIG', '请联系管理员核对云托管测试门店配置', { statusCode })
  }
  if (result.wechatIdentity !== true) {
    return connectionError('health', 'UNAUTHORIZED', '无法确认微信身份，请从已授权的小程序体验版进入', { statusCode })
  }
}

function httpFailure(stage, statusCode, data) {
  // Only the store's error responses carry user-facing business messages.
  const code = data?.code
  if (stage !== 'health' && statusCode && typeof code === 'string' && storeErrorStatuses[code] === statusCode) {
    const hint = typeof data.error === 'string' && data.error ? data.error : '请求未完成，请重试'
    return serviceError(code, hint, { stage, statusCode, tableIds: data.tableIds || [] })
  }
  if (statusCode === 401 || statusCode === 403) {
    return connectionError(stage, 'CONFIG', '当前微信无权连接测试门店，请联系管理员', { statusCode })
  }
  if (stage === 'health') {
    if (statusCode === 404) {
      return connectionError(stage, 'CONFIG', '未找到测试门店服务，请联系管理员', { statusCode })
    }
    if (data?.service === 'shh-booking') {
      const mismatch = healthIdentityError(data, statusCode)
      if (mismatch) return mismatch
    }
  }
  const temporary = temporaryStatuses.has(statusCode)
  const hint = temporary ? '门店服务暂未就绪，请稍后重试' : '请重试'
  return connectionError(stage, 'REQUEST_FAILED', hint, { statusCode, temporary })
}

async function request(path, method = 'GET', data, token) {
  await initializeCloud()
  const stage = path === '/health' ? 'health' : path === '/auth/wechat' ? 'login' : 'request'
  const header = { 'content-type': 'application/json', 'X-WX-SERVICE': cloudRun.service }
  if (token) header.Authorization = 'Bearer ' + token

  return new Promise((resolve, reject) => {
    const fail = error => reject(cloudFailure(stage, error))
    try {
      const pending = wx.cloud.callContainer({
        config: { env: cloudRun.env },
        path, method, data, header, timeout: cloudTimeout,
        success(response) {
          const statusCode = httpStatus(response?.statusCode)
          const body = response?.data
          if (!(statusCode >= 200 && statusCode < 300)) return reject(httpFailure(stage, statusCode, body))
          const mismatch = stage === 'health' && healthIdentityError(body, statusCode)
          if (mismatch) return reject(mismatch)
          resolve(body)
        },
        fail,
      })
      if (typeof pending?.then === 'function') Promise.resolve(pending).catch(fail)
    } catch (error) {
      fail(error)
    }
  }).then(result => {
    if (verifiedServiceActivityAt !== undefined) verifiedServiceActivityAt = Date.now()
    return result
  }, error => {
    if (error.temporary || error.code === 'NETWORK') verifiedServiceActivityAt = undefined
    throw error
  })
}

async function checkTestService() {
  const startedAt = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      await request('/health')
      return
    } catch (error) {
      if (error.stage !== 'health' || !error.temporary || attempt >= healthRetryTimes.length) throw error
      // Give fast gateway failures enough time for the service to finish starting.
      const delay = Math.max(500, healthRetryTimes[attempt] - (Date.now() - startedAt))
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

function verifyTestService() {
  if (serviceVerification) return serviceVerification
  if (verifiedServiceActivityAt !== undefined && Date.now() - verifiedServiceActivityAt < serviceIdleLimit) return
  verifiedServiceActivityAt = undefined
  serviceVerification = checkTestService().then(() => {
    verifiedServiceActivityAt = Date.now()
  }).finally(() => {
    serviceVerification = undefined
  })
  return serviceVerification
}

function acceptSession(result) {
  if (typeof result?.token !== 'string' || !result.token) {
    throw connectionError('login', 'REQUEST_FAILED', '门店服务返回的微信登录信息无效，请重试')
  }
  sessionToken = result.token
  return sessionToken
}

function getSession() {
  if (sessionToken) return sessionToken
  if (!loginRequest) {
    loginRequest = request('/auth/wechat', 'POST', {}).then(acceptSession).finally(() => {
      loginRequest = undefined
    })
  }
  return loginRequest
}

async function staffRequest(path, data) {
  await verifyTestService()
  const token = await getSession()
  try {
    return await request(path, 'POST', data, token)
  } catch (error) {
    if (error.code !== 'UNAUTHORIZED') throw error
    if (sessionToken === token) sessionToken = ''
    return request(path, 'POST', data, await getSession())
  }
}

function openAccess() {
  if (openingAccess) return
  openingAccess = true
  wx.reLaunch({
    url: accessPage,
    complete() { openingAccess = false },
  })
}

async function call(action, data = {}) {
  try {
    return await staffRequest('/api/' + action, data)
  } catch (error) {
    if (error.code === 'ACCESS_PENDING') openAccess()
    throw error
  }
}

async function bindAdmin(password) {
  const result = await staffRequest('/auth/wechat/bind-admin', { password })
  acceptSession(result)
  return result.me
}

async function readInvite(token) {
  await verifyTestService()
  return request('/invite/' + encodeURIComponent(token))
}

async function openReport(date, period = 'day') {
  const report = await call('report', { date, period })
  const bytes = require('./workbook').buildWorkbook(report)
  const filename = period === 'month' ? '门店月报-' + date.slice(0, 7) : '门店日报-' + date
  const filePath = wx.env.USER_DATA_PATH + '/' + filename + '.xlsx'
  const fs = wx.getFileSystemManager()
  await new Promise((resolve, reject) => fs.writeFile({
    filePath, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    success: resolve, fail: () => reject(serviceError('FILE', '保存 Excel 失败，请检查存储空间')),
  }))
  await new Promise((resolve, reject) => wx.openDocument({
    filePath, fileType: 'xlsx', showMenu: true,
    success: resolve, fail: () => reject(serviceError('FILE', '无法打开 Excel 文件，请在手机微信中查看')),
  }))
}

module.exports = {
  call, today, openAccess, bindAdmin, openReport, readInvite,
  bindStaffName: (name, servicePhone) => call('bindStaffName', servicePhone === undefined ? { name } : { name, servicePhone }),
  setServicePhone: servicePhone => call('setServicePhone', { servicePhone }),
}
