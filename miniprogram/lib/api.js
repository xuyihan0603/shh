const { today } = require('./domain')
const { cloudRun } = require('../config')

const accessPage = '/pages/access/index'
let cloudInitialization
let serviceVerification
let loginRequest
let sessionToken = ''
let openingAccess = false

function serviceError(code, message, details) {
  return Object.assign(new Error(message), { code }, details)
}

function initializeCloud() {
  if (cloudInitialization) return cloudInitialization
  let version
  try { version = wx.getAccountInfoSync().miniProgram.envVersion } catch (_) {}
  if (version !== 'develop' && version !== 'trial') {
    throw serviceError('CONFIG', '请使用小程序的体验版进入测试门店')
  }
  if (!cloudRun?.env || !cloudRun?.service) {
    throw serviceError('CONFIG', '请配置测试门店的微信云托管环境和服务')
  }
  if (typeof wx.cloud?.init !== 'function' || typeof wx.cloud?.callContainer !== 'function') {
    throw serviceError('CONFIG', '当前微信版本不支持云托管，请更新微信后重试')
  }
  cloudInitialization = Promise.resolve().then(() => wx.cloud.init({ env: cloudRun.env })).catch(() => {
    cloudInitialization = undefined
    throw serviceError('NETWORK', '无法初始化微信云托管，请检查网络并重试')
  })
  return cloudInitialization
}

async function request(path, method = 'GET', data, token) {
  await initializeCloud()
  const header = { 'content-type': 'application/json', 'X-WX-SERVICE': cloudRun.service }
  if (token) header.Authorization = 'Bearer ' + token

  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: cloudRun.env },
      path, method, data, header, timeout: 60000,
      success(response) {
        const { statusCode, data } = response
        if (statusCode >= 200 && statusCode < 300) return resolve(data)
        reject(serviceError(
          data?.code || (statusCode === 401 ? 'UNAUTHORIZED' : 'REQUEST_FAILED'),
          data?.error || '请求未完成，请重试',
          { tableIds: data?.tableIds || [] },
        ))
      },
      fail() {
        reject(serviceError('NETWORK', '无法连接云托管测试门店，请检查网络并重试'))
      },
    })
  })
}

function verifyTestService() {
  if (!serviceVerification) {
    serviceVerification = request('/health').then(result => {
      if (result?.ok !== true || result.service !== 'shh-booking' || result.storage !== 'mysql' ||
          result.trial !== true || result.auth !== 'wechat' || result.environment !== 'wechat-test') {
        throw serviceError('CONFIG', '云托管测试门店尚未就绪，请联系管理员')
      }
      if (result.wechatIdentity !== true) {
        throw serviceError('UNAUTHORIZED', '无法确认微信身份，请从已授权的小程序体验版进入')
      }
    }).catch(error => {
      serviceVerification = undefined
      throw error
    })
  }
  return serviceVerification
}

function acceptSession(result) {
  if (typeof result?.token !== 'string' || !result.token) {
    throw serviceError('REQUEST_FAILED', '门店服务返回的微信登录信息无效，请重试')
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
