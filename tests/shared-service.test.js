const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {once} = require('node:events')
const {openStore} = require('../server/database')
const {createServer} = require('../server')
const {today} = require('../miniprogram/lib/domain')

const smsSettings = {TENCENT_SECRET_ID:'testing',TENCENT_SECRET_KEY:'testing',SMS_SDK_APP_ID:'testing',SMS_SIGN_NAME:'testing',SMS_TEMPLATE_ID:'testing'}
const acceptedSms = {Response:{SendStatusSet:[{Code:'Ok'}]}}

async function fixture(t, {smsEnv = smsSettings, smsResponse = () => acceptedSms, bindManager = true} = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'shh-booking-check-'))
  const adminPassword = 'unit-only-manager-5Rfa'
  const store = openStore(folder,{adminPassword})
  const second = openStore(folder)
  const sms = []
  const opts = {
    smsEnv,
    smsTransport:async (_url, data) => {
      sms.push(JSON.parse(data.body))
      return {json:smsResponse}
    }
  }
  const servers = [createServer(store,opts),createServer(second,opts)]
  for (const server of servers) {server.listen(0,'127.0.0.1');await once(server,'listening')}
  t.after(async () => {
    await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))))
    store.close(); second.close()
    if (path.dirname(folder)===os.tmpdir() && path.basename(folder).startsWith('shh-booking-check-')) fs.rmSync(folder,{recursive:true})
  })
  const send = async (route,data,token,server=0) => {
    const res=await fetch('http://127.0.0.1:'+servers[server].address().port+route,{
      method:data===undefined ? 'GET' : 'POST',headers:{'content-type':'application/json',...(token ? {Authorization:'Bearer '+token} : {})},
      ...(data===undefined ? {} : {body:JSON.stringify(data)})
    })
    return {status:res.status,body:await res.json()}
  }
  const signIn = async (staffId,password) => {
    const {body,status} = await send('/auth/login',{staffId,password})
    assert.equal(status,200)
    return body.token
  }
  const manager = await signIn('manager',adminPassword)
  const bind = async (token,name) => assert.equal((await send('/api/bindStaffName',{name},token)).status,200)
  if (bindManager) await bind(manager,'林经理')
  async function staff(id,role,{bound = true,name = id} = {}) {
    const password = 'staff-test-only-' + id
    const result = await send('/api/staffSave',{id,name,role,password},manager)
    assert.equal(result.status,200)
    const token = await signIn(id,password)
    if (bound) await bind(token,name === id ? id + '同事' : name)
    return token
  }
  return {send,staff,manager,sms,store}
}

test('首次绑定只更新当前账号，并在不同服务连接间保留接单归属', async t => {
  const {send,staff,manager,store} = await fixture(t,{bindManager:false})
  const historical = store.read().orders
  assert.equal((await send('/api/bindStaffName',{name:'匿名'})).status,401)
  const initial = (await send('/api/bootstrap',{},manager)).body
  assert.deepEqual(initial.me,{id:'manager',name:'管理员',role:'admin',nameBound:false})
  assert.equal(initial.nameSuggestion,'')
  assert.deepEqual(initial.tables,[])
  assert.equal((await send('/api/staffList',{},manager)).body.code,'NAME_REQUIRED')
  assert.equal((await send('/api/bindStaffName',{name:'   '},manager)).status,400)
  assert.equal((await send('/api/bindStaffName',{name:'店长'},manager)).status,400)
  assert.equal((await send('/api/bindStaffName',{name:'manager'},manager)).status,400)

  const names = ['  林经理  ','许经理']
  const attempts = await Promise.all(names.map((name,index) =>
    send('/api/bindStaffName',{name,staffId:'sales1',role:'finance'},manager,index)))
  assert.deepEqual(attempts.map(result=>result.status).sort(),[200,403])
  const confirmed = attempts.find(result=>result.status===200).body
  assert.deepEqual(confirmed,{id:'manager',name:names[attempts.findIndex(result=>result.status===200)].trim(),role:'admin',nameBound:true})
  assert.deepEqual((await send('/api/bootstrap',{},manager,1)).body.me,confirmed)
  assert.deepEqual((await send('/api/bindStaffName',{name:confirmed.name},manager,1)).body,confirmed)
  assert.deepEqual(store.read().orders,historical)
  assert.deepEqual(store.read().staff.map(person=>person.id),['manager'])

  const token = await staff('new-seller','sales',{bound:false,name:'赵小青'})
  const booking = {date:today(),meal:'lunch',time:'12:30',tableIds:['105'],guests:4,contact:'测试顾客',phone:'13800000109'}
  const seller = (await send('/api/bootstrap',{},token)).body
  assert.equal(seller.me.nameBound,false)
  assert.equal(seller.nameSuggestion,'赵小青')
  assert.equal((await send('/api/save',booking,token)).body.code,'NAME_REQUIRED')
  assert.equal((await send('/api/bindStaffName',{name:'  赵小青  '},token,1)).status,200)
  assert.equal((await send('/api/save',{...booking,ownerId:'sales1'},manager)).status,403)
  assert.equal((await send('/api/save',{...booking,ownerName:'其他员工'},token)).status,403)

  const {status,body:order} = await send('/api/save',booking,token)
  assert.equal(status,200,order.error)
  assert.equal(order.ownerId,'new-seller')
  assert.equal(order.ownerName,'赵小青')
  assert.equal(order.logs[0].actorName,'赵小青')
  const edit = {id:order.id,version:order.version,guests:6}
  assert.equal((await send('/api/save',{...edit,ownerId:'manager',createdDate:today()},manager)).status,403)
  const updated = (await send('/api/save',edit,manager)).body
  assert.equal(updated.guests,6)
  assert.equal(updated.ownerId,order.ownerId)
  assert.equal(updated.ownerName,order.ownerName)
  assert.equal(updated.createdDate,order.createdDate)
  assert.deepEqual(updated.logs[0],order.logs[0])
  assert.equal(updated.logs[1].actorName,confirmed.name)

  const alice = await staff('alice','sales',{bound:false})
  assert.equal((await send('/api/bootstrap',{},alice)).body.nameSuggestion,'')
  const binding = await send('/api/bindStaffName',{name:'Alice'},alice)
  assert.equal(binding.status,200,binding.body.error)
  assert.equal(binding.body.name,'Alice')
})

test('两个服务连接抢同一桌，冲突不占其他桌；旧版本换桌不能覆盖成功操作', async t=>{
  const {send,staff} = await fixture(t)
  const a = await staff('a','sales'), b = await staff('b','sales')
  const base = {date:today(),meal:'lunch',kind:'booking',time:'12:30',guests:4,contact:'验收客人',phone:'13800000099'}
  const responses = await Promise.all([
    send('/api/save',{...base,tableIds:['201','202']},a,0),
    send('/api/save',{...base,tableIds:['202','203']},b,1)
  ])
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409])
  const winner = responses.findIndex(r=>r.status===200)
  const order = responses[winner].body
  const token = winner===0 ? a : b
  const loser = winner===0 ? b : a
  const spare = winner===0 ? '203' : '201'
  const board = (await send('/api/board',{date:today(),meal:'lunch'},token)).body
  assert.equal(board.tables.find(t=>t.id===spare).orderId,null)
  assert.equal((await send('/api/order',{id:order.id},loser)).body.phone,'138****0099')
  assert.equal((await send('/api/save',{id:order.id,version:order.version,guests:3},loser)).status,403)
  const changed = (await send('/api/save',{id:order.id,version:order.version,tableIds:[spare]},token)).body
  assert.equal((await send('/api/cancel',{id:order.id,version:order.version},token)).body.code,'VERSION_CONFLICT')
  assert.equal((await send('/api/order',{id:order.id},token,1)).body.version,changed.version)
  assert.equal((await send('/api/order',{id:order.id,actorId:'manager'})).status,401)
})

test('同单一份公开邀请随换桌更新、取消失效；短信模板和重试采用同一订单',async t=>{
  const {send,staff,manager,sms} = await fixture(t)
  const sales = await staff('seller','sales')
  const stranger = await staff('another','sales')
  const order = (await send('/api/save',{date:today(),meal:'dinner',time:'18:30',tableIds:['101'],guests:3,contact:'核对人',phone:'13800000077',notes:'仅限员工',deposit:100,depositMethod:'微信'},sales)).body
  assert.equal((await send('/api/prepareInvite',{id:order.id},stranger)).status,403)
  assert.equal((await send('/api/notifySms',{id:order.id},stranger)).status,403)
  const link = (await send('/api/prepareInvite',{id:order.id},sales)).body
  assert.equal(link.version,order.version)
  assert.ok(!link.trial)
  assert.deepEqual(link.sms,{phone:order.phone,enabled:true,status:'ready',reason:''})
  assert.equal((await send('/api/prepareInvite',{id:order.id},manager)).body.token,link.token)
  const first = (await send('/invite/'+link.token)).body
  assert.equal(first.time,'18:30'); assert.equal(first.guests,3)
  for (const prop of ['notes','contact','ownerName','logs','deposit','sms','version','trial']) assert.equal(first[prop],undefined)
  assert.notEqual(first.phone,order.phone)
  const changed = (await send('/api/save',{id:order.id,version:order.version,tableIds:['103'],phone:'13800000078'},manager)).body
  assert.deepEqual((await send('/invite/'+link.token)).body.tableNames,['103'])
  const stale = await send('/api/notifySms',{id:order.id,version:link.version},manager,1)
  assert.equal(stale.status,409)
  assert.equal(stale.body.code,'VERSION_CONFLICT')
  assert.equal(sms.length,0)
  const updated = (await send('/api/prepareInvite',{id:order.id},manager)).body
  assert.equal(updated.token,link.token)
  assert.equal(updated.sms.phone,changed.phone)
  assert.equal((await send('/api/notifySms',{id:order.id,version:updated.version},manager)).body.sent,true)
  assert.equal((await send('/api/notifySms',{id:order.id},manager)).body.repeated,true)
  assert.equal(sms.length,1); assert.deepEqual(sms[0].TemplateParamSet,[first.store,today(),'晚餐','18:30','103'])
  assert.deepEqual(sms[0].PhoneNumberSet,['+8613800000078'])
  assert.equal((await send('/api/prepareInvite',{id:order.id},manager)).body.sms.status,'accepted')
  assert.equal((await send('/api/cancel',{id:order.id,version:changed.version},manager)).status,200)
  assert.equal((await send('/invite/'+link.token)).status,410)
  assert.equal((await send('/api/prepareInvite',{id:order.id},manager)).status,410)
})

test('员工预览预订文字时按当前桌位生成消息，不创建公开链接',async t=>{
  const {send,staff,manager,store} = await fixture(t)
  const owner = await staff('text-seller','sales')
  const other = await staff('text-other','sales')
  const order = (await send('/api/save',{date:today(),meal:'dinner',time:'18:00',
    tableIds:['205'],guests:8,contact:'验收用客人',phone:'13800000077',notes:'员工专用备注'},owner)).body
  const details = await send('/api/notificationDetails',{id:order.id},owner)
  assert.equal(details.status,200)
  assert.equal(details.body.token,undefined)
  const {invitationText} = require('../miniprogram/lib/invitation')
  const text = invitationText(details.body.card)
  assert.ok(text.includes('餐位:二楼205包房\n人数8位！'))
  assert.ok(!text.includes('员工专用备注') && !text.includes('13800000077'))
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM invites').get().n,0)
  assert.equal((await send('/api/notificationDetails',{id:order.id},other)).status,403)
  await send('/api/cancel',{id:order.id,version:order.version},manager)
  assert.equal((await send('/api/notificationDetails',{id:order.id},owner)).status,410)
})

test('101 桌和邀请均标原接单人，代改、更新或清除员工手机号后通知仍取正确资料', async t => {
  const {send, staff, manager, store} = await fixture(t)
  const seller = await staff('seller-xu','sales',{name:'徐'})
  const originalPhone = '13900000023'
  const updatedPhone = '13900000024'
  const guestPhone = '13800000077'
  assert.equal((await send('/api/setServicePhone',{servicePhone:originalPhone},seller)).status,200)
  await send('/api/setServicePhone',{servicePhone:'13900000025'},manager)
  const input = {date:today(),meal:'dinner',time:'18:30',tableIds:['101'],guests:4,contact:'客人',phone:guestPhone}
  assert.equal((await send('/api/save',{...input,ownerServicePhone:guestPhone},seller)).status,403)
  const order = (await send('/api/save',input,seller)).body
  assert.equal(store.read().orders.find(item=>item.id===order.id).ownerServicePhone,originalPhone)
  const board = (await send('/api/board',{date:today(),meal:'dinner'},manager)).body
  assert.equal(board.tables.find(table=>table.id==='101').ownerName,'徐')
  assert.ok(!JSON.stringify(board).includes(originalPhone))

  const changed = await send('/api/save',{id:order.id,version:order.version,guests:5},manager)
  assert.equal(changed.status,200)
  const details = (await send('/api/notificationDetails',{id:order.id},manager)).body
  assert.equal(details.card.serviceName,'徐')
  assert.equal(details.card.servicePhone,originalPhone)
  assert.equal(details.sms.phone,guestPhone)
  assert.ok(!JSON.stringify(details.card).includes(guestPhone))
  const {token} = (await send('/api/prepareInvite',{id:order.id},seller)).body

  await send('/api/setServicePhone',{servicePhone:updatedPhone},seller)
  assert.equal((await send('/api/notificationDetails',{id:order.id},manager,1)).body.card.servicePhone,updatedPhone)
  assert.equal((await send('/invite/'+token)).body.servicePhone,updatedPhone)
  await send('/api/setServicePhone',{servicePhone:''},seller)
  const cleared = (await send('/invite/'+token)).body
  assert.equal(cleared.serviceName,'徐')
  assert.ok(!cleared.servicePhone)
  assert.equal((await send('/api/notificationContext',{id:order.id},seller)).status,404)
})

test('两个服务同时发送只提交一次，腾讯云超时后保持待核对',async t=>{
  const responding = Promise.withResolvers()
  const reply = Promise.withResolvers()
  const {send,manager,sms} = await fixture(t,{smsResponse:() => {
    responding.resolve()
    return reply.promise
  }})
  const order = (await send('/api/save',{date:today(),meal:'lunch',time:'12:30',tableIds:['103'],guests:3,contact:'核对人',phone:'13800000077'},manager)).body
  const input = {id:order.id,version:order.version}
  const first = send('/api/notifySms',input,manager)
  try {
    await Promise.race([responding.promise,first])
    const preview = await send('/api/prepareInvite',{id:order.id},manager,1)
    assert.equal(preview.body.sms.status,'pending')
    const duplicate = await send('/api/notifySms',input,manager,1)
    assert.equal(duplicate.status,409)
    assert.equal(duplicate.body.code,'NOTIFY_PENDING')
    assert.equal(sms.length,1)
  } finally {
    reply.resolve({Response:{Error:{Code:'InternalError.Timeout'}}})
    await first
  }
  assert.equal((await first).body.code,'NOTIFY_PENDING')
  assert.equal((await send('/api/notifySms',input,manager,1)).body.code,'NOTIFY_PENDING')
  assert.equal(sms.length,1)
})

test('短信配置和接收号码独立于邀请，平台明确拒绝后可重试',async t=>{
  const smsEnv = {}
  const responses = [{Response:{SendStatusSet:[{Code:'FailedOperation.SignatureIncorrectOrUnapproved'}]}},acceptedSms]
  const {send,manager,sms} = await fixture(t,{smsEnv,smsResponse:() => responses.shift()})
  const payload = {date:today(),meal:'lunch',time:'12:30',guests:3,contact:'核对人'}
  const order = (await send('/api/save',{...payload,tableIds:['103'],phone:'13800000077'},manager)).body
  const landline = (await send('/api/save',{...payload,tableIds:['105'],phone:'010-55550100'},manager)).body

  const invite = await send('/api/prepareInvite',{id:order.id},manager)
  assert.equal(invite.status,200)
  assert.equal(invite.body.sms.enabled,false)
  assert.match(invite.body.sms.reason,/配置/)
  assert.equal((await send('/invite/'+invite.body.token)).status,200)
  assert.equal((await send('/api/notifySms',{id:order.id},manager)).body.code,'SMS_UNCONFIGURED')

  Object.assign(smsEnv,smsSettings)
  const landlineInvite = await send('/api/prepareInvite',{id:landline.id},manager)
  assert.equal(landlineInvite.status,200)
  assert.equal(landlineInvite.body.sms.enabled,false)
  assert.match(landlineInvite.body.sms.reason,/手机号/)
  assert.equal((await send('/api/notifySms',{id:landline.id},manager)).body.code,'VALIDATION')
  assert.equal(sms.length,0)

  const input = {id:order.id,version:invite.body.version}
  assert.equal((await send('/api/notifySms',input,manager)).body.code,'SMS_FAILED')
  assert.equal((await send('/api/prepareInvite',{id:order.id},manager,1)).body.sms.status,'failed')
  assert.equal((await send('/api/notifySms',input,manager,1)).body.sent,true)
  assert.equal(sms.length,2)

  const arrival = await send('/api/arrive',input,manager)
  assert.equal(arrival.status,200)
  assert.equal((await send('/api/prepareInvite',{id:order.id},manager)).status,410)
  assert.equal((await send('/api/notifySms',{id:order.id,version:arrival.body.version},manager)).status,410)
  assert.equal((await send('/invite/'+invite.body.token)).status,200)
})

test('调整员工角色或停用后原会话失效',async t=>{
  const {send,staff,manager}=await fixture(t)
  const token=await staff('bookkeeper','finance')
  assert.equal((await send('/api/report',{date:today(),basis:'meal'},token)).status,200)
  assert.equal((await send('/api/staffSave',{id:'bookkeeper',name:'员工',role:'sales'},manager)).status,200)
  assert.equal((await send('/api/report',{date:today(),basis:'meal'},token)).status,401)
})
