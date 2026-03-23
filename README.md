# 康骑卫士平台 Demo

这是一个带完整账号体系和角色区分的比赛级演示平台，用来模拟“智能骑行眼镜 + 后方雷达”在康复骑行场景中的工作流程。

## 当前能力

- 注册 / 登录
- 三种角色：患者、医生、家属
- SQLite 数据库持久化
- 患者建档与骑行场景选择
- 实时骑行会话与风险事件记录
- 骑行结束后自动生成安全报告
- 医生端调整患者预警阈值
- 医生端标记患者骑行状态
- 家属关联患者并接收页面内通知
- 通知中心与未读提醒

## 技术栈

- 前端：HTML / CSS / JavaScript
- 后端：Node.js / Express
- 数据库：SQLite（`better-sqlite3`）
- 鉴权：Bearer Token
- 密码加密：`bcryptjs`
- 实时更新：SSE
- 邮件发送：`nodemailer` + SMTP
- 环境变量：`dotenv`
- 地图与定位：高德 JS 地图

## 启动方式

```bash
npm install
npm start
```

启动后访问：

```bash
http://localhost:3000
```

## Docker 部署

后端已经支持直接运行在 Docker 中。当前项目因为前端静态资源由 Express 一并托管，所以用一个后端容器就能跑完整个演示系统。

### 1. 先准备环境变量

```bash
cp .env.example .env
# 然后把 .env 改成你的真实 SMTP 配置
```

### 2. 启动容器

```bash
docker compose up --build
```

启动后访问：

```bash
http://localhost:3000
```

### 3. 停止容器

```bash
docker compose down
```

### 4. 数据持久化

SQLite 数据库会保存在 Docker volume `kangqei_data` 中，不会因为容器重建而丢失。

如果你想连数据库和卷一起清掉：

```bash
docker compose down -v
```

## 邮件发送配置

当骑行报告生成后，系统会尝试把报告邮件发送到：

- 患者注册邮箱
- 已关联家属的注册邮箱

发送前请先配置 SMTP 环境变量。可以参考 [.env.example](/Users/hahadong/PycharmProjects/mitdemo2/.env.example)：

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your_account@example.com
SMTP_PASS=your_smtp_password
SMTP_FROM=your_account@example.com
SMTP_FROM_NAME=康骑卫士平台
```

推荐做法：

```bash
cp .env.example .env
# 然后把 .env 改成你的真实 SMTP 配置
npm start
```

如果你要启用患者端高德地图与定位，还需要补充：

```bash
AMAP_WEB_KEY=你的高德WebKey
```

未配置 SMTP 时，系统不会真正发信，但会把本次发送记录记为 `skipped`。

## 默认演示账号

系统启动时会自动写入一个医生账号：

- 邮箱：`doctor@demo.com`
- 密码：`demo1234`

患者和家属账号请在页面中自行注册。

## 数据文件

SQLite 数据库默认保存在：

```bash
data/kangqei-demo.db
```

## 说明

当前版本已经实现完整的多角色演示链路，但仍然属于比赛 Demo：

- 实时骑行目标仍由脚本模拟
- 会话实时状态仍部分依赖内存
- 通知为页面内推送模拟
- 前端仍为原生 JS 实现，便于快速演示和修改
- 登录 token 保存在浏览器 `sessionStorage`，因此同一浏览器不同标签页可以分别登录不同用户

## 邮件发送记录

报告邮件的发送结果会落在数据库表 `email_deliveries` 中。

你也可以通过接口查看某次骑行的邮件记录：

```bash
GET /api/rides/:id/emails
```
