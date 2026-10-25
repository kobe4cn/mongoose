# @kobe4cn/nestjs-mongoose

基于官方 `@nestjs/mongoose` 的轻量增强版本，由 [Kevin Yang](https://github.com/kobe4cn) 维护，与 NestJS 官方团队无隶属关系。

- 上游项目：[nestjs/mongoose](https://github.com/nestjs/mongoose)
- 当前项目：[kobe4cn/mongoose](https://github.com/kobe4cn/mongoose)
- 问题反馈：[GitHub Issues](https://github.com/kobe4cn/mongoose/issues)

---

## 解决的核心问题

在原生 `@nestjs/mongoose` 中，当在 `MongooseModule.forRootAsync` 中使用动态工厂（例如注入了 `@Inject(REQUEST)` 来根据请求头动态获取数据库 URI 或配置）时，NestJS 的依赖注入容器会因作用域传染将底层数据库提供者提升为 **`Scope.REQUEST`（请求作用域）**。

这会导致**每个进来的 HTTP 请求都会重新调用 `mongoose.createConnection` 创建一个全新的底层连接池**（包含独立的 TCP Socket 集合、认证流程和心跳监听），而请求结束后这些连接池并不会被销毁，极易导致 MongoDB 连接数耗尽（Connection Leak）与连接风暴。

本库在保持与官方 API 100% 兼容的前提下，通过底层全局连接池去重与生命周期管理机制彻底解决该问题：

1. **自动按 `[URI, dbName]` 共享连接池**：
   相同 URI 与数据库名称的多次访问自动复用已有连接池，避免重复建连。
2. **高并发防击穿（Thundering Herd Protection）**：
   同一数据库连接在首次初始化时，并发请求自动共享同一个创建中的 Promise；建连失败自动剔除缓存并支持重试。
3. **全面兼容懒连接（Lazy Connection）**：
   完全支持 `lazyConnection: true` 模式，后台连接失败时自动从缓存中清除并安全回收。
4. **优雅停机（Graceful Shutdown）**：
   应用接收到 NestJS `onApplicationShutdown` 停机信号时，自动安全关闭所有已缓存的数据库连接池，并具备停机状态保护，杜绝停机窗口期内新建未受管连接。

---

## 安装

```bash
npm install @kobe4cn/nestjs-mongoose mongoose
# 或使用 pnpm
pnpm add @kobe4cn/nestjs-mongoose mongoose
```

> **兼容依赖**：NestJS 11 或 12、Mongoose 8/9、RxJS 7。

---

## 使用示例

所有用法、装饰器及模块定义与官方 `@nestjs/mongoose` 完全一致，仅需替换导入包名：

### 1. 动态/多租户连接池复用示例

```typescript
import { Module } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@kobe4cn/nestjs-mongoose';
import type { Request } from 'express';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService, REQUEST],
      useFactory: async (configService: ConfigService, req: Request) => {
        const tenantId = (req.headers['x-tenant-id'] as string) || 'default';
        return {
          uri: configService.get<string>(`MONGODB_URI_${tenantId}`),
        };
      },
    }),
  ],
})
export class MongodbModule {}
```

在上述场景下，即使 `useFactory` 在每个请求到来时都会被执行，只要解析出的 MongoDB `uri` 相同，底层就会自动复用同一个连接池，不会重复建连。

### 2. 标准单例用法

```typescript
import { Module } from '@nestjs/common';
import { MongooseModule } from '@kobe4cn/nestjs-mongoose';

@Module({
  imports: [
    MongooseModule.forRoot('mongodb://localhost:27017/my_database'),
  ],
})
export class AppModule {}
```

### 3. 模型定义与注入

```typescript
import { Module } from '@nestjs/common';
import { MongooseModule, InjectModel, InjectConnection } from '@kobe4cn/nestjs-mongoose';
import { Connection, Model } from 'mongoose';
import { Cat, CatSchema } from './schemas/cat.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Cat.name, schema: CatSchema }]),
  ],
})
export class CatsModule {}

// Service 中注入
export class CatsService {
  constructor(
    @InjectModel(Cat.name) private readonly catModel: Model<Cat>,
    @InjectConnection() private readonly connection: Connection,
  ) {}
}
```

---

## 本地开发与构建

```bash
# 安装依赖
pnpm install

# 编译构建
pnpm build

# 运行测试
pnpm test:e2e
```

---

## 许可证

本项目采用 [MIT 许可证](LICENSE)，保留上游项目的版权声明与许可证。原作者为 Kamil Myśliwiec，增强版由 Kevin Yang 维护。
