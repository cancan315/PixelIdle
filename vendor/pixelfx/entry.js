// pixelfx 构建入口：这里决定哪些特效进入产物。
//
// 加新特效：在下面加一行 import + export 即可，然后跑 `node scripts/build-fx.js`。
// 每多一个特效约增加 2~6 KB（压缩后），核心部分是一次性成本。
//
// 注意：esbuild 只保留实际被引用到的代码，所以没有被 import 的特效不会增加体积。

export { createFrame, clearFrame, createFx, composite } from "./core/index.js";

import * as hitSpark from "./fx/impacts/hit-spark.js";
export { hitSpark };
