# hpack-subset

一个用于**测试环境**的 HPACK（[RFC 7541](https://www.rfc-editor.org/rfc/rfc7541)）子集库，用 TypeScript 编写、运行于 Node.js 20，不依赖任何 HTTP/2 或 HPACK 第三方库。

## 支持的特性

- 静态表（Appendix A，61 条）索引表示（§6.1）
- 动态表：逐连接维护，条目大小按 §4.1（UTF-8 字节数 + 32）计算，按 §4.3/4.4 从最旧条目开始逐出
- 整数前缀编码（§5.1），前缀位数 1–8，含多字节续码
- 三种字面量表示：
  - 增量索引（§6.2.1）
  - 不索引（§6.2.2）
  - 永不索引 / sensitive（§6.2.3）——敏感头不会进入动态表
- 动态表大小更新（§6.3），包括一个头块内的连续多次更新；按规范大小更新必须出现在块首
- 原始（非 Huffman）字符串（§5.2）

## 不支持的特性

- **Huffman 编码**：编码器从不产生 Huffman；解码器一旦遇到 H 位会抛出 `HuffmanUnsupportedError`。

## 语义保证

- **失败原子性**：解码一个头块期间任何表示出错，动态表都会整块回滚，不会留下部分插入或大小更新。
- **跨块复用**：成功解码后动态表状态保留，供同一连接的后续头块使用。
- **连接隔离**：每个 `HpackEncoder` / `HpackDecoder` 实例拥有独立动态表，互不影响。
- **快照不可变**：`snapshot()` 返回深拷贝，调用方无法借此修改内部状态。

## 使用

```ts
import { HpackEncoder, HpackDecoder } from "./src/index.js";

const encoder = new HpackEncoder(4096); // SETTINGS_HEADER_TABLE_SIZE
const decoder = new HpackDecoder(4096);

const block = encoder.encode([
  { name: ":method", value: "GET" },                              // 默认可索引
  { name: "authorization", value: "Bearer x", indexing: "never" }, // 敏感，不进表
  { name: "x-trace", value: "abc", indexing: "none" },           // 仅本次不索引
]);

const headers = decoder.decode(block);
// [{ name: ":method", value: "GET", sensitive: false }, ...]

// 动态表大小更新（SETTINGS_HEADER_TABLE_SIZE 变化）
encoder.updateTableSize(0);
encoder.updateTableSize(2048);             // 在下一个 encode() 的块首连续发出

// 断言用快照（深拷贝）
const snap = decoder.snapshot();
snap.entries; // [{ name, value }, ...]，按插入顺序（最旧在前）
snap.size;    // 当前条目大小之和
snap.maxSize; // 当前上限
```

`Decoder` 侧调整本地容量可用 `decoder.setMaxTableSize(n)`（会立即逐出）。线上来的大小更新若超过构造时声明的上限，抛 `HpackDecodingError` 并回滚整块。

## 错误类型

- `HpackError`：所有库错误的基类
- `HpackDecodingError`：畸形块、索引越界、截断、大小更新位置/数值非法等
- `HuffmanUnsupportedError`：遇到 Huffman 标志位

## 命令

```sh
npm install
npm test         # tsc 编译后用 node --test 运行 dist/test
npm run typecheck
```
