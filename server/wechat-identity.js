const { digest, fault } = require('./store-rules')

function createWechatIdentity(env = process.env) {
  const { WECHAT_APP_ID: appId, WECHAT_CLOUD_ENV: cloudEnvironment } = env
  if (!/^wx[a-f0-9]{16}$/.test(appId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(cloudEnvironment ?? '')) {
    throw Error('微信测试门店须设置 WECHAT_APP_ID 和 WECHAT_CLOUD_ENV')
  }

  return headers => {
    // Cloud Hosting injects these headers on its private WeChat ingress. The test service has no public ingress.
    const source = headers['x-wx-source']
    const openId = headers['x-wx-openid']
    const environment = headers['x-wx-env']
    if (typeof source !== 'string' || !source.trim() || source.includes(',') || headers['x-wx-appid'] !== appId ||
        typeof openId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(openId) ||
        (environment !== undefined && environment !== cloudEnvironment)) {
      throw fault('UNAUTHORIZED', '请在本小程序内使用微信身份进入测试门店')
    }
    return digest(`${appId}:${openId}`)
  }
}

module.exports = { createWechatIdentity }
