const crypto = require('node:crypto')
const {publicInvitation, smsFields} = require('../miniprogram/lib/invitation')
const {fault, digest} = require('./store-rules')

const requiredSmsSettings = ['TENCENT_SECRET_ID','TENCENT_SECRET_KEY','SMS_SDK_APP_ID','SMS_SIGN_NAME','SMS_TEMPLATE_ID']
const smsMessages = {
  VALIDATION: '此订单未登记有效的中国大陆手机号',
  SMS_UNCONFIGURED: '门店尚未配置签名短信，可以使用手机短信或复制预订消息',
  accepted: '短信平台已受理',
  pending: '短信已提交或发送结果待核对，请先在腾讯云短信控制台查询',
  failed: '短信平台拒绝本次请求，请店长核对签名、模板及接收号码',
}

function describeSms({order,store:details,tables,owner,trial}, env) {
  const card = publicInvitation(details,order,tables,owner)
  const phone = order.phone || ''
  const params = smsFields(card)
  const key = digest(JSON.stringify([order.id,phone,params]))
  let unavailable
  if (!/^1[3-9]\d{9}$/.test(phone)) unavailable = 'VALIDATION'
  else if (!requiredSmsSettings.every(setting => typeof env[setting] === 'string' && env[setting].trim())) unavailable = 'SMS_UNCONFIGURED'
  return {card,version:order.version,trial,phone,params,key,unavailable}
}

function canSendSms({unavailable}, status) {
  if (status === 'accepted') return false
  if (status === 'pending') throw fault('NOTIFY_PENDING',smsMessages.pending)
  if (unavailable) throw fault(unavailable,smsMessages[unavailable])
  return true
}

function responseDetails({card,version,trial,phone,unavailable}, status) {
  const reason = status === 'accepted' || status === 'pending'
    ? smsMessages[status] : smsMessages[unavailable || status] || ''
  return {card, version, trial, sms:{phone,enabled:!unavailable,status,reason}}
}

async function notificationDetails(store, actor, id, env = process.env, token) {
  const details = describeSms(await store.run(actor,'notificationContext',{id},token),env)
  return responseDetails(details,await store.notificationStatus(details.key))
}

async function prepareInvite(store, actor, id, env = process.env, session) {
  const {details,status,token} = await store.prepareInvite(actor,id,session,env)
  return {...responseDetails(details,status),token}
}

async function readInvite(store, token) {
  const orderId = await store.findInvite(token)
  if (!orderId) throw fault('NOT_FOUND', '邀请函不存在，请联系门店')
  const state = await store.read()
  const order = state.orders.find(o => o.id === orderId)
  if (!order || order.status === 'cancelled') throw fault('GONE', '这份预订已取消或失效，请联系门店')
  const names = order.tableNames || order.tableIds.map(id => state.tables.find(t => t.id === id)?.name || id)
  const owner = state.staff.find(person => person.id === order.ownerId)
  return publicInvitation(state.store, {...order,tableNames:names}, state.tables, owner)
}

function signRequest(env, body, timestamp) {
  const host = 'sms.tencentcloudapi.com'
  const headers = 'content-type:application/json; charset=utf-8\nhost:' + host + '\n'
  const signed = 'content-type;host'
  const date = new Date(timestamp*1000).toISOString().slice(0,10)
  const scope = date + '/sms/tc3_request'
  const canonical = ['POST','/','',headers,signed,digest(body)].join('\n')
  const signing = ['TC3-HMAC-SHA256',timestamp,scope,digest(canonical)].join('\n')
  const hmac = (key, text) => crypto.createHmac('sha256',key).update(text).digest()
  const signingKey = hmac(hmac(hmac('TC3'+env.TENCENT_SECRET_KEY,date),'sms'),'tc3_request')
  return {
    'Content-Type':'application/json; charset=utf-8',
    'Authorization':'TC3-HMAC-SHA256 Credential='+env.TENCENT_SECRET_ID+'/'+scope+', SignedHeaders='+signed+', Signature='+hmac(signingKey,signing).toString('hex'),
    'X-TC-Timestamp':String(timestamp), 'X-TC-Region':env.SMS_REGION || 'ap-guangzhou',
    'X-TC-Version':'2021-01-11','X-TC-Action':'SendSms'
  }
}

async function sendSms(store, actor, id, env = process.env, transport = fetch, version, token) {
  const {phone,params,key,status} = await store.claimSms(actor,id,version,token,env)
  if (status === 'accepted') return {sent:true,repeated:true}

  const body = JSON.stringify({SmsSdkAppId:env.SMS_SDK_APP_ID,SignName:env.SMS_SIGN_NAME,
    TemplateId:env.SMS_TEMPLATE_ID,PhoneNumberSet:['+86'+phone],TemplateParamSet:params})
  let reply
  try {
    const result = await transport('https://sms.tencentcloudapi.com/', {
      method:'POST',headers:signRequest(env,body,Math.floor(Date.now()/1000)),body,
      redirect:'error',signal:AbortSignal.timeout(10000)
    })
    if (result.ok !== false) reply = (await result.json())?.Response
  } catch {
    throw fault('NOTIFY_PENDING',smsMessages.pending)
  }
  const recipients = reply?.SendStatusSet
  const recipient = Array.isArray(recipients) && recipients.length === 1 ? recipients[0] : null
  const code = reply?.Error ? reply.Error.Code : recipient?.Code
  if (typeof code !== 'string' || !code.trim() || /^(InternalError|ServiceUnavailable|ResponseSizeLimitExceeded)(\.|$)/.test(code)) {
    throw fault('NOTIFY_PENDING',smsMessages.pending)
  }
  const accepted = code === 'Ok' && !reply.Error
  await store.setNotificationStatus(key,accepted?'accepted':'failed')
  if (!accepted) throw fault('SMS_FAILED',smsMessages.failed)
  return {sent:true}
}

module.exports = {describeSms,canSendSms,notificationDetails,prepareInvite,readInvite,sendSms}
