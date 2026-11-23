# 珊瑚海门店预订

微信小程序 AppID 为 `wxa3eaf9dbbf214997`。开发版和体验版连接同一套云端测试门店，门店起始数据包括 24 个桌位和一个待绑定的管理员账号。

## 门店人员第一次使用

1. 用自己的微信扫描体验码。微信公众平台的体验成员资格由小程序管理者设置。
2. 首次进入时登记员工姓名。店长在「等待分配权限」页点「首次绑定管理员」，输入专属绑定口令认领管理员身份。同一个微信再次扫码会识别为原员工。
3. 新员工先等待授权。店长在「我的 → 员工权限」按姓名和登记编号分配前台、客户经理或财务。接单人员填写服务手机号后，可从桌态新建预订。预订文字和桌卡会显示原接单人。
4. 店长和财务在「日报」按用餐日或整月查看消费额、订金和员工订单数，点待补笔数可进入相应订单。店长可以补录消费并导出 Excel。

## 从 Git 部署测试后端

微信云托管使用 `prod-d4goi868p5197ee86` 环境下的 `django-6h4h` 服务。选择仓库 `xuyihan0603/shh` 的 `main` 分支、根目录的 `Dockerfile`、容器端口 `8080`。选择要测试的提交执行构建。小程序通过微信云托管内网调用，云服务须关闭公网入口，只授权对应小程序。[微信云托管调用说明](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/call/mini.html)

服务使用 MySQL 连接设置 `MYSQL_ADDRESS`、`MYSQL_USERNAME`、`MYSQL_PASSWORD`，订单、微信身份和权限存入专用数据库 `shh_booking_test`。启动参数在 Dockerfile 中。旧库 `shh_booking` 与测试库独立。

第一次初始化测试库时，可运行 `python deploy/wechat-cloud/package.py`。将本机 `.runtime/wechat-test/admin-verifier.txt` 的一行校验值写入云端服务设置 `STORE_ADMIN_RECORD`。将 `.runtime/wechat-test/first-login.txt` 第二行的绑定口令交给店长本人。这些文件均在版本控制之外。完成绑定后，后续 Git 部署沿用云端账号和权限。

用同一 AppID 的开发者工具调用 `GET /health` 验收。响应的 `service` 应为 `shh-booking`，`environment` 应为 `wechat-test`，`storage` 应为 `mysql`，`ok` 和 `wechatIdentity` 均为 `true`。本地业务回归使用 Node.js 22.13 或更新版本运行 `npm test`。

### 用手机号识别回头客

新建预订时先输入客人手机号。有到店记录且留过姓名的客人会自动带出姓名、到店次数和客群标签，员工可在本笔预订中更正姓名。相同手机号每笔实际到店的订单计一次，一单订多桌也计一次。待到店与已取消预订不计入次数。前台和店长可查看全店来电历史，客户经理可通过完整号码识别回头客，订单明细仍按岗位权限展示。

店长和财务打开「日报 → 客群分析」可按截止日查看累计客群和最近 4 周或 8 周的每周对比。同一联系电话累计到店 1 次为新客，2–3 次为可发展客，4 次及以上为 VVIP。每周图中，一个号码在同一周只计一人，以该周结束时的到店次数划分客群。点选某周可查看三类客人的人数及与前一周的差额。

### 分享预订和发送短信

在已预订的订单详情打开「预订消息」，核对门店模板生成的正文，点「选择微信联系人」，选好好友或群聊后，在微信聊天工具里确认发送文字。该能力适用于微信 iOS / Android 8.0.56 及以上、基础库 3.7.8 及以上。也可以点「复制预订消息」，切换到微信对话后粘贴发送。[微信聊天工具模式](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/chatTool.html)

正文列出用餐日期、星期、午宴或晚宴、餐位、人数、地址和订餐电话。「专职为您服务」一行使用原预订员工的姓名和服务手机号。员工换号后重新打开预订消息即可生成带新号码的文字。旧账号尚未填写号码时，通知页会提醒补填。

正式发布前，在微信公众平台「用户隐私保护指引」中声明剪切板用途，说明员工主动复制预订消息用于发送给客人。自动复制不可用时，员工仍可长按正文选择复制。[微信用户隐私保护指引](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html)

在安卓上，点「发送短信 → 复制完整正文 → 打开短信并粘贴」，手机短信会带入收件号码。把整段门店模板粘贴到编辑框即可确认发送，避免微信预填长文本时报「内容超出正文上限」。也可以核对页面上的精简正文后点「发送精简短信」，让手机同时带入号码和简短的用餐信息。若微信无法打开系统短信，页面提供手动复制号码和正文的步骤。手机短信按手机套餐计费。[微信手机短信接口](https://developers.weixin.qq.com/miniprogram/dev/api/device/sms/wx.sendSms.html)

测试门店使用手机系统短信。正式门店如需统一以门店签名发送，在服务端配置腾讯云短信的 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`SMS_SDK_APP_ID`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_ID`，可选 `SMS_REGION`。签名与通知模板需已审核通过，模板按顺序接收门店名、用餐日期、餐段、到店时间、桌位五个参数。员工核对号码并确认「用门店短信发送」后，页面展示平台受理状态。相同订单、号码与模板内容会去重；若受理状态未知，先在供应商控制台核实。[腾讯云发送短信文档](https://cloud.tencent.com/document/product/382/55981)
