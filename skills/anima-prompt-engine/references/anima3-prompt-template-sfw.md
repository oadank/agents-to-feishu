# ANIMA3 提示词生成模板 v1.0

> 融合 anima3 V2 骨架 + AI-KSK 规则 + 所长常规NovalAI个人法典标签库
> 本模板只输出画面内容提示词，不处理质量词、画师、底模、负向提示词或生成参数。

---

## 0. 快速开始

本模板 = **规则框架** + **标签库**。拿到需求后按以下路径使用：

| § | 章节 | 用途 |
|---|---|---|
| 0 | 快速开始 | 你在看 |
| 1 | ROLE | AI的行为准则——怎么做、不怎么做 |
| 2 | OUTPUT PROTOCOL | 输出格式硬规则（一行、全小写、禁止什么） |
| 3 | KEY VISUAL FORMULA | 做封面/海报/剧情大图时必看——5步写出故事感 |
| 4 | FINAL SELF-CHECK | 输出前逐条自查，防低级错误 |
| 5 | SLOT ORDER | **核心**：标签填充顺序 + 风格一致性铁律 + 数量控制 + 自然语言写法 + 视线规则 |
| 6 | COUNT & IDENTITY | 几个人、什么IP角色 |
| 7 | APPEARANCE | **标签库**：外貌——发色发型/瞳色/体型/肤色/非人特征 |
| 8 | CLOTHING & STATE | **标签库**：服装——7大风格系 + 精华搭配组合 |
| 9 | POSE & ACTION | **标签库**：姿态动作——站坐卧/动态/战斗/手势/互动 |
| 10 | EXPRESSION & REACTION | **标签库**：表情反应——8种情绪+身体生理反应 |
| 11 | CAMERA & SHOT | **标签库**：镜头——景别/视角/角度/对焦/构图/分镜 |
| 12 | SCENE & LOCATION | **标签库**：场景——7大风格系地点/天气/时辰 |
| 13 | DETAIL & MOOD | **标签库**：氛围——灯光/质感/特效/运动渲染 |
| 14 | 重跑/改图 | 已有好底图、只换剧情时的改prompt策略 |
| 15 | ASSEMBLY DECISION TREE | 8种场景类型各自怎么填槽位 |
| 16 | CONFLICT TABLE | 绝对不能同时出现的标签对，输出前对照 |
| 17 | 实战案例 | 跑图验证过的完整案例（持续更新） |

**典型执行顺序**：需求 → §15 查场景类型 → §5 风格一致性选系 → §7-13 各槽位翻词库填tag → §4 自检 → §16 互斥检查 → 输出

---

## 1. ROLE

不解释、不寒暄、不输出markdown。输出**一整行纯文本 prompt**。

---

## 2. OUTPUT PROTOCOL

| 规则 | 说明 |
|---|---|
| 行数 | 仅1行，无换行 |
| 分隔 | 标签间用`, ` |
| 大小写 | 全部lowercase |
| 权重 | 禁止写权重语法，字段顺序即隐式权重 |
| 禁止输出 | 质量词、画师名、底模名、负向提示词、LoRA、分辨率、采样参数、工作流或节点信息 |
| 输出形式 | 纯文本一行，无code fence、无markdown |
| 自然语言补充 | 标签无法准确描述时，用英文自然语言短句补充，**放prompt末尾** |

---

## 3. KEY VISUAL FORMULA（剧情主视觉5步法 · 来源：AI-KSK）

| 步骤 | 内容 |
|---|---|
| 第1步 | 给主体身份（角色是谁） |
| 第2步 | 给当下动作（角色在做什么） |
| 第3步 | 给冲突背景（周围发生了什么） |
| 第4步 | 给观众关系（角色与观看者的关系） |
| 第5步 | 补风格词（anime key visual等） |

---

## 4. FINAL SELF-CHECK

| # | 检查项 |
|---|---|
| 1 | 人数标签与实际角色数一致 |
| 2 | 无互斥标签冲突 |
| 3 | 无重复标签 |
| 4 | 场景与动作物理兼容 |
| 5 | 标签总数在对应场景复杂度范围内 |

---

## 5. SLOT ORDER（标签槽位顺序）

```
[count/gender] → [character/series] → [appearance] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [detail/mood] → [natural language]
```

> ⚡ **核心原则：跨槽位风格一致性**
> 
> 标签库中各槽位按**风格系**组织（古风东方 / 赛博科幻 / 哥特暗黑 / 日常现代 / 奇幻异世界 / 自然户外 / 战斗废墟）。
> 
> **选定一个风格系后，所有槽位必须从同一风格系中选词。** 不要出现 `clothing = 汉服` + `scene = 赛博都市` 这类跨系混搭（除非刻意追求融合效果）。
> 
> | 如果 clothing 选了… | scene 应该选… | mood 应该偏向… |
> |---|---|---|
> | 古风东方系 | 场景库 §12.2（古风/东方） | §13 水墨 / 空灵 / 柔光 |
> | 赛博科幻系 | 场景库 §12.1（赛博/科幻） | §13 霓虹 / 故障 / 数字质感 |
> | 哥特暗黑系 | 场景库 §12.3（哥特/暗黑） | §13 暗光 / 雾气 / 胶片颗粒 |
> | 日常现代系 | 场景库 §12.5（室内/日常） | §13 柔和室内光 / 暖色调 |
> | 奇幻异世界系 | 场景库 §12.6（奇幻/异世界） | §13 光粒子 / 空灵 / 史诗 |
> | 战斗废墟 | 场景库 §12.7（战斗/废墟） | §13 爆炸 / 烟雾 / 速度线 |
> 
> `appearance`、`pose`、`expression` 虽然没有按风格系分库，但也要与整体基调匹配——古风角色不宜用 `ahegao`，赛博角色不宜用 `serene expression`。

### 5.1 TAG COUNT CONTROL

> 基于已填充的词库实际规模更新。服装/外貌槽位词库体量大，不设硬上限。

| 场景复杂度 | 总标签数 |
|---|---|
| 简单（单人展示） | 20-30 |
| 标准（双人互动） | 28-45 |
| 复杂（多人/剧情主视觉） | 35-55 |

**每槽位标签数指引**：

| 槽位 | 最少 | 最多 | 说明 |
|---|---|---|---|
| count/gender | 2 | 4 | 固定格式 |
| character/series | 0 | 2 | 仅IP角色使用 |
| appearance | 3 | 不限 | 发色发型+瞳色+体型+肤色+非人特征+标记 |
| clothing/state | 2 | 不限 | 服装类型+材质+细节+穿着状态，词库体量最大 |
| pose/action | 2 | 7 | 姿态+动作+手势+互动 |
| expression/reaction | 1 | 4 | 主表情+辅助反应 |
| camera/shot | 1 | 5 | 景别+视角+角度+对焦+构图 |
| scene/location | 2 | 8 | 场所+建筑+自然景观+天气+时辰+环境道具 |
| detail/mood | 0 | 3 | 氛围/渲染效果（按需） |

原则：靠前槽位权重更高，选精不选多。同一部位不堆叠矛盾状态标签。服装槽位虽不限上限，但应避免冗余堆砌——精选有代表性的标签比全量罗列效果好。

### 5.2 NATURAL LANGUAGE SUPPLEMENT

**核心原则**：tag为主，自然语言仅在tag无法准确表达时使用，放prompt末尾。

#### 自然语言5要素公式（来源：AI-KSK）

| 要素 | 说明 |
|---|---|
| 主体位置/姿态 | 角色在画面中的空间位置和身体状态 |
| 正在做的动作 | 具体行为，不是状态描述 |
| 关键道具 | 前景或手中的叙事道具 |
| 镜头与观众关系 | 角色与画外观看者的互动方式 |
| 情绪与故事冲突 | 这一刻发生了什么 |

#### 多人场景角色规则

必须为每个角色补充关键外观描述。结构：
```
[人数] → [角色A外观] → [角色B外观] → [共享tag] → [自然语言: 关系/动作/剧情]
```

### 5.3 FACING & AUDIENCE

#### 视线方向默认规则

- **单人场景**：除非用户明确要求背对/侧脸/from behind，否则强制注入直视镜头
- **两人及以上**：不强制，根据角色互动关系选择合适视线标签，或由用户指定

| 用户意图 | 适用 | 输出 |
|---|---|---|
| 未指定/正面（单人） | solo | `direct eye contact, facing viewer` |
| 回头（浪漫） | solo | `turning around, direct eye contact` |
| 回眸（肩头） | solo | `over shoulder, direct eye contact` |
| 背对/远去 | 通用 | `from behind, facing away` |
| 侧脸 | 通用 | `profile, from side` |
| 角色间互动（多人） | 2人+ | `looking at another` |

#### 观众关系（叙事性互动）

当场景具有剧情性时，用自然语言（放末尾）描述角色与观众的叙事关系。类型包括：邀请/共犯、审判/对峙、托付/交接、挑衅/诱惑、求助/绝望、告别/远行 等。

---

## 6. COUNT & IDENTITY（主体层）

### 人数与性别
| 中文 | tag |
|---|---|
| 一女 | `1girl, solo` |
| 一男 | `1boy, solo` |
| 一男一女 | `1girl, 1boy` |
| 两女 | `2girls` |
| 两男 | `2boys` |
| 三女及以上 | `Xgirls, multiple girls` |
| 三男及以上 | `Xboys, multiple boys` |
| 男女混合多人 | `Xgirls, Xboys, multiple girls, multiple boys` |

### IP角色规则
- 命中IP时必须写 `character, series` + **≥5个外观锚点**（发型/发色/眼色/标志服饰/配饰）
- 原创角色：直接描述外观，不写character/series

### 体型差/年龄差
| 类型 | tag |
|---|---|
| 身高差 | `height difference, size difference` |
| 年龄差 | `age difference` |

---


> 对应模板槽位：`[appearance]`
> 内容：发色发型、瞳色瞳型、体型身材、肤色、非人特征、身体标记

## 7. APPEARANCE（外貌层）

> 对应模板槽位：`[appearance]`
> 内容：发色发型、瞳色瞳型、体型身材、肤色、非人特征、身体标记

### 7.1 头发

#### 7.1.1 长度
| 标签 | 说明 |
|---|---|
| `long hair` | 长发 |
| `medium hair` | 中长发 |
| `short hair` | 短发 |
| `shoulder-length hair` | 齐肩发 |

#### 7.1.2 颜色
| 标签 | 说明 |
|---|---|
| `black hair` | 黑发 |
| `white hair` / `silver hair` | 白发/银发 |
| `blonde hair` | 金发 |
| `brown hair` | 棕发 |
| `red hair` | 红发 |
| `pink hair` | 粉发 |
| `blue hair` | 蓝发 |
| `purple hair` | 紫发 |
| `green hair` | 绿发 |
| `grey hair` / `ash-blonde` | 灰发/灰金 |
| `multicolored hair` / `two-tone hair` | 多色发/双色发 |
| `gradient hair` | 渐变发色 |
| `hair with golden highlights` | 金色挑染 |
| `hair like ink` | 墨色发（水墨风专用） |

#### 7.1.3 发型
| 标签 | 说明 |
|---|---|
| `long flowing hair` | 飘逸长发 |
| `wavy hair` | 波浪卷 |
| `curly hair` | 卷发 |
| `straight hair` | 直发 |
| `messy hair` / `disheveled hair` | 凌乱发/散乱发 |
| `fluffy hair` | 蓬松发 |
| `wind-blown hair` / `hair flowing in wind` | 风中飘发 |
| `floating hair` | 浮空发（超自然/水下） |
| `hair floating upwards` | 发向上漂浮 |

#### 7.1.4 扎发/编发
| 标签 | 说明 |
|---|---|
| `ponytail` | 马尾 |
| `twin tails` / `low twintails` | 双马尾/低双马尾 |
| `twin braids` | 双辫 |
| `side ponytail` | 侧马尾 |
| `braid` / `braided ponytail` | 辫子/编辫马尾 |
| `hair bun` / `double bun` | 发髻/双丸子头 |
| `low chignon` | 低发髻 |
| `hair tied back` | 头发后扎 |
| `loose braid` | 松散辫子 |

#### 7.1.5 刘海/细节
| 标签 | 说明 |
|---|---|
| `bangs` / `blunt bangs` | 刘海/齐刘海 |
| `parted bangs` | 分刘海 |
| `crossed bangs` | 交叉刘海 |
| `hair between eyes` | 发遮眼 |
| `hair over one eye` | 发遮单眼 |
| `eyes visible through hair` | 透过发丝可见眼 |
| `ahoge` | 呆毛 |
| `sidelocks` | 鬓发 |
| `hair strands` / `loose strands of hair` | 散落发丝 |

### 7.2 眼睛

#### 7.2.1 颜色
| 标签 | 说明 |
|---|---|
| `blue eyes` / `light blue eyes` | 蓝眼/浅蓝眼 |
| `red eyes` / `bright red eyes` | 红眼/亮红眼 |
| `green eyes` | 绿眼 |
| `golden eyes` / `amber eyes` | 金眼/琥珀眼 |
| `grey eyes` | 灰眼 |
| `pink eyes` | 粉色眼 |
| `purple eyes` | 紫色眼 |
| `aqua eyes` / `crystal aqua eyes` | 水色眼/水晶水色眼 |
| `heterochromia` | 异色瞳 |
| `multicolored eyes` / `gradient eyes` | 多色/渐变瞳 |

#### 7.2.2 瞳型/特效
| 标签 | 说明 |
|---|---|
| `slit pupils` / `snake-like pupils` | 竖瞳/蛇瞳 |
| `glowing eyes` / `piercing eyes` | 发光眼/锐利眼 |
| `bright pupils` | 明亮瞳孔 |
| `blank eyes` / `empty eyes` / `hollow glazed eyes` | 空洞眼/失焦眼 |
| `sparkling eyes` | 闪闪发亮眼 |
| `half-closed eyes` / `heavy-lidded eyes` | 半闭眼/慵懒眼 |
| `sharp eyes` | 锐利眼神 |
| `colored sclera` / `black sclera` | 异色巩膜/黑巩膜 |
| `diamond-shaped pupils` / `symbol-shaped pupils` | 菱形瞳/符号瞳 |
| `detailed eyes` / `beautiful detailed eyes` | 精细眼 |

### 7.3 身体

#### 7.3.1 体型
| 标签 | 说明 |
|---|---|
| `slim` / `slender` | 苗条/纤细 |
| `petite` | 娇小 |
| `curvy` | 有曲线的 |
| `voluptuous` / `voluptuous figure` | 丰满性感 |
| `muscular` / `muscular female` | 肌肉/健美女 |
| `toned` | 精实紧致 |
| `lean build` | 精瘦 |
| `tall and slender` | 高挑纤细 |
| `athletic` | 运动型 |

#### 7.3.2 身材部位
| 标签 | 说明 |
|---|---|
| `large breasts` / `huge breasts` | 大胸/巨乳 |
| `medium breasts` / `small breasts` | 中胸/小胸 |
| `wide hips` | 宽臀 |
| `thick thighs` / `large thighs` | 粗腿/大腿 |
| `long legs` | 长腿 |
| `muscular arms` | 肌肉手臂 |
| `slender waist` | 细腰 |

#### 7.3.3 肤色
| 标签 | 说明 |
|---|---|
| `pale skin` / `fair skin` | 苍白/白皙皮肤 |
| `white skin` | 白色皮肤 |
| `dark skin` / `dark-skinned female` | 深色/黑皮肤 |
| `tan` / `tan lines` | 日晒肤色/晒痕 |
| `porcelain skin` | 瓷器肤质 |
| `grey skin` | 灰色皮肤 |
| `colored skin` / `blue skin` | 异色皮肤/蓝皮 |
| `shiny skin` / `dewy skin` | 光泽肤/水润肤 |
| `luminescent skin` | 发光皮肤 |

### 7.4 非人特征

#### 7.4.1 兽耳/尾
| 标签 | 说明 |
|---|---|
| `animal ears` | 兽耳（通用） |
| `cat ears` / `fox ears` / `dog ears` / `rabbit ears` | 猫耳/狐耳/狗耳/兔耳 |
| `animal ear fluff` | 兽耳绒毛 |
| `tail` / `cat tail` / `fox tail` / `dog tail` | 尾巴/猫尾/狐尾/狗尾 |
| `multiple tails` / `nine tailed fox` | 多尾/九尾狐 |
| `dragon tail` | 龙尾 |
| `fish tail` / `shark tail` | 鱼尾/鲨鱼尾 |

#### 7.4.2 精灵/恶魔/天使
| 标签 | 说明 |
|---|---|
| `elf` / `pointy ears` | 精灵/尖耳 |
| `dark elf` / `drow` | 暗精灵 |
| `demon` / `demon horns` / `demon tail` | 恶魔/魔角/魔尾 |
| `succubus` | 魅魔 |
| `angel` / `angel wings` | 天使/天使翼 |
| `fallen angel` | 堕落天使 |
| `halo` / `spiked halo` | 光环/尖刺光环 |

#### 7.4.3 翅膀
| 标签 | 说明 |
|---|---|
| `wings` | 翅膀（通用） |
| `feathered wings` | 羽翼 |
| `dragon wings` / `bat wings` | 龙翼/蝙蝠翼 |
| `butterfly wings` | 蝴蝶翅膀 |
| `insect wings` | 昆虫翅膀 |
| `translucent wings` / `semi transparent wings` | 半透明翼 |
| `flaming wings` | 火焰翼 |
| `energy wings` | 能量翼 |
| `mechanical wings` | 机械翼 |
| `glowing wings` | 发光翼 |

#### 7.4.4 龙娘/龙族
| 标签 | 说明 |
|---|---|
| `dragon girl` | 龙娘 |
| `dragon horns` / `eastern dragon horn` | 龙角/东方龙角 |
| `dragon tail` | 龙尾 |
| `dragon wings` | 龙翼 |
| `scales` / `scales covering skin` | 鳞片/鳞片覆盖皮肤 |

#### 7.4.5 机械/赛博格
| 标签 | 说明 |
|---|---|
| `robot` / `android` | 机器人/仿生人 |
| `cyborg` | 赛博格 |
| `mechanical parts` / `mechanical arms` / `mechanical legs` | 机械部件/机械臂/机械腿 |
| `mechanical hands` | 机械手 |
| `robot joints` | 机器人关节 |
| `exposed mechanical components` | 外露机械组件 |
| `cables` / `wires` / `circuits` | 线缆/电线/电路 |
| `barcode` / `identification markings` | 条码/识别标记 |
| `metal skin` / `metallic surface` | 金属皮肤/金属表面 |

#### 7.4.6 其他非人
| 标签 | 说明 |
|---|---|
| `monster girl` / `spider girl` / `shark girl` | 魔物娘/蜘蛛娘/鲨鱼娘 |
| `mermaid` / `siren` | 人鱼/塞壬 |
| `fairy` / `sprite` | 妖精/精灵 |
| `vampire` / `fangs` | 吸血鬼/尖牙 |
| `werewolf` / `wolf ears` / `wolf tail` | 狼人/狼耳/狼尾 |
| `oni` / `horns` | 鬼/角 |
| `zombie` / `undead` | 丧尸/不死族 |
| `ghost` / `ethereal` / `translucent body` | 幽灵/空灵/半透明体 |
| `slime` | 史莱姆 |
| `doll` / `doll joints` / `living doll` | 人偶/人偶关节/活人偶 |
| `furry` / `furry female` / `dog girl` | 兽人/犬娘 |

### 7.5 身体标记/装饰

| 标签 | 说明 |
|---|---|
| `tattoo` / `arm tattoo` / `back tattoo` / `leg tattoo` | 纹身/臂纹身/背纹身/腿纹身 |
| `intricate tattoos` | 精致纹身 |
| `glowing tattoo` / `circuit tattoo` | 发光纹身/电路纹身 |
| `scar` / `battle scars` | 伤疤/战斗疤痕 |
| `freckles` | 雀斑 |
| `mole` / `mole under eye` | 痣/泪痣 |
| `beauty mark` | 美人痣 |
| `body markings` | 身体标记 |
| `body writing` | 身体书写文字 |
| `piercing` / `ear piercing` / `navel piercing` | 穿孔/耳洞/脐钉 |

---


---

## 8. CLOTHING & STATE（服装与穿着状态层）

> 对应模板槽位：`[clothing/state]`
> 内容：服装类型/材质/细节 + 穿着状态。按风格系组织，保留配方中的搭配组合

---

### 8.1 古风东方系

#### 8.1.1 汉服体系
| 标签 | 说明 |
|---|---|
| `hanfu` | 汉服通用 |
| `flowing hanfu` / `flowing sleeves` | 飘逸汉服/广袖 |
| `qixiong ruqun` | 齐胸襦裙 |
| `white and pale blue hanfu` | 白+淡蓝汉服配色 |
| `layered robes` | 层叠袍服 |
| `sheer fabrics` | 薄纱面料 |
| `wide sleeves` | 宽袖 |
| `embroidered silk` | 绣花丝绸 |
| `traditional chinese dress` | 中式传统服装（通用） |
| `light cyan hanfu-inspired dress with subtle dragon scale patterns embroidered on sleeves and hem` | 浅青汉服+龙鳞纹刺绣（端午节配方） |
| `indigo ramie robe` | 靛蓝苎麻袍 |
| `wide sleeves stained with ink-blue watermarks` | 水墨染宽袖 |

#### 8.1.2 旗袍体系
| 标签 | 说明 |
|---|---|
| `cheongsam` / `china dress` / `qipao` | 旗袍 |
| `black cheongsam` | 黑色旗袍 |
| `high-slit dress` / `side slit` | 高开衩/侧开衩 |
| `sleeveless dress` | 无袖旗袍 |
| `intricate chinese patterns` / `cloud patterns` | 中式纹样/云纹 |
| `silk` / `translucent fabric` | 丝绸/半透明面料 |
| `vintage lace-trimmed silk cheongsam (smoke grey with plum blossom embroidery)` | 复古蕾丝边旗袍（烟灰+梅绣） |
| `modified black cheongsam with revealing cutouts` | 改良黑色镂空旗袍 |

#### 8.1.3 和服体系
| 标签 | 说明 |
|---|---|
| `kimono` | 和服 |
| `furisode` | 振袖（长袖和服） |
| `yukata` | 浴衣 |
| `yukata with asagao pattern` | 牵牛花纹浴衣 |
| `red kimono` | 红色和服 |
| `black and gold accents` | 黑金配色 |
| `ivory white fabric` | 象牙白面料 |
| `intricate gold leaf pattern` | 精致金箔花纹 |
| `red obi` | 红色腰带 |
| `obi` / `obijime` / `obidome` | 腰带/带绳/带留 |

#### 8.1.4 古风配饰
| 标签 | 说明 |
|---|---|
| `jade bangle` / `jade bracelet` | 玉镯 |
| `jade pendant` | 玉坠 |
| `gold necklace featuring jade gemstones` | 金镶玉项链 |
| `red tassel` / `tassels` | 红色流苏/流苏 |
| `hair ornament (peony-shaped)` / `intricate silver hair ornament` | 牡丹发饰/精致银发饰 |
| `oil-paper umbrella` / `red paper umbrella` | 油纸伞/红纸伞 |
| `hand fan` / `folding fan` / `holding chinese fan` | 团扇/折扇/中国扇 |
| `red ribbon` | 红丝带 |
| `forehead jewel` / `forehead mark (gold dot)` | 额饰/额点金 |
| `chinese hairpin` / `feathered hairpin` | 中式发簪/羽簪 |
| `veil` / `red veil with golden thread edging` | 面纱/金线红盖头 |

#### 8.1.5 婚嫁/礼服
| 标签 | 说明 |
|---|---|
| `intricate phoenix crown with dangling pearls` | 凤冠 |
| `xiuhe jacket in vibrant red silk` | 秀禾服（大红丝绸） |
| `dragon-phoenix motif embroidery` | 龙凤纹刺绣 |
| `xiapei bridal cape with jade pendants` | 霞帔 |
| `red wedding dress` | 红色嫁衣 |
| `golden phoenix embroidery` | 金凤刺绣 |
| `double happiness symbol` | 双喜符号 |
| `embroidered waist sash with tassels` | 刺绣腰带+流苏 |
| `traditional chinese bridal makeup` | 中式新娘妆 |

#### 8.1.6 道袍/武侠
| 标签 | 说明 |
|---|---|
| `flowing white taoist robe` | 白色道袍 |
| `white hanfu` | 白色汉服 |
| `leather arm bracers` | 皮护臂 |
| `cloud-pattern waist sash` | 云纹腰带 |
| `moon-white silk robe with ink splashed hem` | 月白丝袍+泼墨下摆 |
| `crimson inner garment peeking at collar` | 绯红内衬露领口 |

---

### 8.2 赛博朋克/科幻系

#### 8.2.1 战甲/战术服
| 标签 | 说明 |
|---|---|
| `mechanical combat armor` | 机械战斗装甲 |
| `combat-ready armor with luminous circuit patterns` | 战斗装甲+发光电路纹 |
| `tight-fitting solid white sci-fi bodysuit` | 紧身纯白科幻连体衣 |
| `high-cut design` | 高开叉设计 |
| `side cut-outs revealing waist and hips` | 侧面镂空露腰臀 |
| `glowing cyan circuits` | 发光青色电路 |
| `waist-length futuristic space jacket` | 齐腰未来太空夹克 |
| `asymmetrical – armored right sleeve, left arm bare` | 不对称装甲（右臂甲、左臂裸） |
| `oxygen tubes` / `utility pockets` | 氧气管/工具袋 |
| `futuristic glowing waist belt` | 未来发光腰带 |
| `cybernetic ear headset with luminous tips` | 赛博耳机+发光尖端 |

#### 8.2.2 赛博格/义体
| 标签 | 说明 |
|---|---|
| `cyborg` / `robotic parts` | 赛博格/机器人部件 |
| `mechanical arms` / `mechanical legs` | 机械臂/机械腿 |
| `mechanical hands` | 机械手 |
| `exposed mechanical components` | 外露机械零件 |
| `cables, wires, batteries, and screws` | 线缆/电线/电池/螺丝 |
| `energy conduits emit a red glow` | 能量导管散发红光 |
| `barcode` / `identification markings` / `logo 05` | 条码/识别标记/编号"05" |
| `transparent glass face shield` / `dark see-through glass mask` | 透明玻璃面罩/深色透视面具 |
| `screen on face` / `head-mounted display` | 面部屏幕/头显 |

#### 8.2.3 赛博服饰/街头
| 标签 | 说明 |
|---|---|
| `techwear` | 科技服饰 |
| `holographic jacket` | 全息夹克 |
| `neon trim` / `glowing accents` | 霓虹镶边/发光点缀 |
| `fiber-optic hair strands` | 光纤发丝 |
| `glitch-effect collar` | 故障效果衣领 |
| `translucent synthwave visor` | 半透明合成波面罩 |
| `data-stream hair highlights` | 数据流发丝高光 |
| `retro-futuristic shoulder pads` | 复古未来风肩垫 |
| `prismatic ankle boots` | 棱镜及踝靴 |
| `oversized denim jacket with holographic thread accents` | 超大牛仔夹克+全息线点缀 |

---

### 8.3 哥特/暗黑系

#### 8.3.1 哥特Lolita
| 标签 | 说明 |
|---|---|
| `gothic lolita` | 哥特洛丽塔 |
| `black dress` / `gothic dress` | 黑色连衣裙/哥特裙 |
| `corset` / `lace` / `frills` | 紧身胸衣/蕾丝/荷叶边 |
| `frilled dress` / `frilled sleeves` | 荷叶边裙/荷叶边袖 |
| `black thighhighs` / `lace-trimmed legwear` | 黑色过膝袜/蕾丝边腿饰 |
| `high heels` / `black footwear` | 高跟鞋/黑色鞋履 |
| `black bonnet` / `cape` | 黑色软帽/斗篷 |
| `juliet sleeves` / `puffy sleeves` | 朱丽叶袖/泡泡袖 |
| `black rolita` / `black rose` | 黑洛丽塔/黑玫瑰 |

#### 8.3.2 暗黑/女巫/恶魔
| 标签 | 说明 |
|---|---|
| `witch` / `witch hat` | 女巫/女巫帽 |
| `black cloak` / `flowing black cloak` | 黑斗篷/飘逸黑斗篷 |
| `tattered black and emerald-green robes glowing with arcane energy` | 破烂黑绿法袍发光 |
| `demon girl` / `succubus` | 恶魔娘/魅魔 |
| `black dragon wings` | 黑龙翼 |
| `horns` / `spiked halo` | 角/尖刺光环 |
| `elaborate monochrome dress with voluminous ruffles` | 精致单色裙+丰盈荷叶边 |
| `white thigh-high stockings adorned with ornate garters` | 白过膝袜+华丽吊袜带 |

#### 8.3.3 暗黑配件
| 标签 | 说明 |
|---|---|
| `choker` / `spiked collar` | 项圈/尖刺项圈 |
| `crystal wine glass` / `deep red wine` | 水晶酒杯/深红酒 |
| `skull` / `bone` / `skeleton motifs` | 骷髅/骨骼/骷髅装饰 |
| `cross necklace` / `cross earrings` | 十字架项链/十字架耳环 |
| `black gloves` / `lace gloves` | 黑手套/蕾丝手套 |

---

### 8.4 日常现代系

#### 8.4.1 学院/制服
| 标签 | 说明 |
|---|---|
| `school uniform` | 校服（通用） |
| `sailor uniform` / `serafuku` | 水手服/日式校服 |
| `white shirt` / `collared shirt` | 白衬衫/有领衬衫 |
| `pleated skirt` / `miniskirt` | 百褶裙/迷你裙 |
| `black necktie` / `red bowtie` / `ribbon` | 黑领带/红领结/丝带 |
| `blazer` / `cardigan` | 西装外套/开衫 |
| `kneehighs` / `loafers` | 及膝袜/乐福鞋 |
| `torn school uniform (white blouse with ripped collar, navy pleated skirt)` | 破损校服（破领白衬衫+藏蓝百褶裙） |

#### 8.4.2 职场/制服
| 标签 | 说明 |
|---|---|
| `office lady` / `business suit` | OL/商务套装 |
| `white shirt` + `pencil skirt` | 白衬衫+铅笔裙 |
| `black jacket` / `black coat` | 黑夹克/黑外套 |
| `necktie` / `id card` | 领带/工牌 |
| `glasses` | 眼镜 |
| `police uniform` / `police vest` / `police badge` | 警服/警用背心/警徽 |
| `military cap` | 军帽 |
| `nurse` / `medical gown` / `nurse cap` | 护士/医疗服/护士帽 |
| `maid outfit` / `french maid` / `maid headdress` | 女仆装/法式女仆/女仆头饰 |
| `apron` / `waist apron` / `naked apron` | 围裙/腰围裙/裸体围裙 |
| `construction worker uniform` | 建筑工人制服 |

#### 8.4.3 毛衣/针织
| 标签 | 说明 |
|---|---|
| `sweater` / `knit sweater` | 毛衣/针织衫 |
| `off-shoulder sweater` | 露肩毛衣 |
| `oversized sweater` | 超大毛衣 |
| `fluffy oversized sweater with paw prints` | 蓬松超大毛衣+爪印 |
| `cardigan` / `loose cardigan` | 开衫/宽松开衫 |
| `turtleneck` | 高领衫 |
| `green sweater` | 绿色毛衣 |
| `red sweater` | 红色毛衣 |
| `soft lavender knit sweater` | 柔紫针织毛衣 |

#### 8.4.4 外套/大衣
| 标签 | 说明 |
|---|---|
| `jacket` / `open jacket` | 夹克/敞开夹克 |
| `black coat` / `long coat` | 黑外套/长外套 |
| `trench coat` / `white trench coat with razor-sharp edges` | 风衣/锋利白风衣 |
| `fur trim` / `fur-lined cloak` | 毛边/毛皮衬里斗篷 |
| `puffy dark blue coat` | 蓬松深蓝外套 |
| `hoodie` / `hooded jacket` / `hood up` / `hood down` | 卫衣/带帽夹克/帽戴/帽放 |
| `denim jacket` | 牛仔夹克 |

#### 8.4.5 下装
| 标签 | 说明 |
|---|---|
| `skirt` / `miniskirt` / `long skirt` / `high-waist skirt` | 裙/短裙/长裙/高腰裙 |
| `pleated skirt` / `plaid skirt` | 百褶裙/格子裙 |
| `black skirt` / `blue skirt` / `red skirt` / `white skirt` | 各色裙 |
| `pants` / `black pants` / `jeans` / `shorts` | 裤子/黑裤/牛仔裤/短裤 |
| `light blue jeans` | 浅蓝牛仔裤 |

#### 8.4.6 鞋袜
| 标签 | 说明 |
|---|---|
| `thighhighs` / `black thighhighs` / `white thighhighs` | 过膝袜/黑/白过膝袜 |
| `knee-high socks` / `ankle socks` | 及膝袜/短袜 |
| `pantyhose` / `black pantyhose` / `white pantyhose` | 连裤袜/黑/白连裤袜 |
| `fishnets` / `fishnet pantyhose` | 网袜/渔网连裤袜 |
| `striped thighhighs` / `pastel color knee-high socks with stripes` | 条纹过膝袜/粉彩条纹及膝袜 |
| `high heels` / `stiletto heels` | 高跟鞋/细高跟 |
| `boots` / `thigh boots` / `ankle boots` / `fur boots` | 靴/长靴/短靴/毛靴 |
| `mary janes` / `loafers` / `sneakers` | 玛丽珍鞋/乐福鞋/运动鞋 |
| `barefoot` | 赤脚 |
| `white socks` / `black socks` / `frilled socks` / `loose socks` | 白袜/黑袜/花边袜/宽松袜 |

#### 8.4.7 配饰/小物
| 标签 | 说明 |
|---|---|
| `glasses` / `black-framed eyewear` / `round eyewear` | 眼镜/黑框眼镜/圆框眼镜 |
| `sunglasses` / `tinted eyewear` | 墨镜/有色眼镜 |
| `hair ribbon` / `hair bow` | 发带/发蝴蝶结 |
| `headband` / `hairband` | 头带/发箍 |
| `hair flower` / `flower hair ornament` | 发花/花饰 |
| `earrings` / `hoop earrings` | 耳环/圈状耳环 |
| `necklace` / `choker` / `pendant` | 项链/项圈/吊坠 |
| `bracelet` / `bangle` / `wristband` | 手镯/手环/腕带 |
| `ring` / `multiple rings` | 戒指/多枚戒指 |
| `watch` / `pocket watch` | 手表/怀表 |
| `bag` / `shoulder bag` / `backpack` / `small belt bag` | 包/挎包/背包/腰包 |
| `scarf` / `shawl` | 围巾/披肩 |
| `belt` / `waist sash` / `garter straps` | 腰带/腰封/吊袜带 |
| `bowtie` / `ribbon bow` | 领结/蝴蝶结 |

---

### 8.5 奇幻/异世界系

#### 8.5.1 魔法/法师
| 标签 | 说明 |
|---|---|
| `magical girl` | 魔法少女 |
| `layered pink dress that flutters in the air` | 层叠粉色裙+飘动 |
| `flowing ribbons and frilled sleeves` | 飘带+荷叶边袖 |
| `witch hat` / `pointed hat` | 女巫帽/尖顶帽 |
| `purple mage robe` | 紫色法师袍 |
| `translucent multicolored wings shaped like shifting flame-like butterflies` | 半透明多色蝴蝶焰翼 |
| `golden wand that radiates power` | 发光金色魔杖 |
| `rose embroidery` / `capelet` | 玫瑰刺绣/小披肩 |

#### 8.5.2 精灵/异族
| 标签 | 说明 |
|---|---|
| `elf` + `leaf-patterned dress` | 精灵+叶纹裙 |
| `delicate silver tiara` | 精致银头冠 |
| `shimmering wings` | 闪光翅膀 |
| `leather boots with buckles` | 带扣皮靴 |
| `small quiver on her back` | 背挂小箭筒 |
| `wooden staff` | 木杖 |

#### 8.5.3 铠甲/战服
| 标签 | 说明 |
|---|---|
| `armor` / `full armor` | 铠甲/全甲 |
| `gold armor` / `silver armor` | 金甲/银甲 |
| `breastplate` / `pauldrons` | 胸甲/肩甲 |
| `armored dress` / `armored skirt` | 装甲裙 |
| `bikini armor` | 比基尼铠甲 |
| `damaged armor` / `torn clothes` | 破损铠甲/撕裂衣物 |
| `shoulder-mounted artillery system` | 肩扛式火炮系统 |
| `chainmail underlay` | 锁子甲内衬 |

#### 8.5.4 蒸汽朋克
| 标签 | 说明 |
|---|---|
| `steampunk` / `steampunk outfit` | 蒸汽朋克/蒸汽朋克服 |
| `hat with gears and cogs motif` | 齿轮图案帽 |
| `corset` / `cape` / `goggles` | 紧身胸衣/斗篷/护目镜 |
| `tesla coils` | 特斯拉线圈 |
| `pocket watch` / `leather satchel` | 怀表/皮挎包 |
| `highly detailed edwardian fashion` | 精致爱德华时代时尚 |

#### 8.5.5 特殊材质/概念服
| 标签 | 说明 |
|---|---|
| `latex` / `rubber` / `pvc` / `shiny` | 乳胶/橡胶/PVC/光泽 |
| `leather` | 皮革 |
| `transparent clothing` / `see-through` | 透明服装/透视 |
| `holographic cloth` / `holographic pleated skirt` | 全息布料/全息百褶裙 |
| `liquid mercury silk textures` | 液态水银丝绸质感 |
| `translucent gauze overskirt` | 半透明薄纱外裙 |
| `crystalline armor` / `crystal embedded gauntlets` | 水晶甲/水晶嵌护手 |

---

### 8.6 内衣/泳装/睡衣

#### 8.6.1 内衣
| 标签 | 说明 |
|---|---|
| `lingerie` / `lace lingerie` | 内衣/蕾丝内衣 |
| `bra` / `lace bra` | 胸罩/蕾丝胸罩 |
| `panties` / `thong` / `g-string` | 内裤/丁字裤/G弦裤 |
| `corset` / `corset with intricate floral embroidery` | 紧身胸衣/花卉刺绣胸衣 |
| `garter belt` / `garter straps` | 吊袜带 |
| `sheer` / `see-through` | 薄纱/透视 |
| `bodystocking` / `fishnet bodystocking` | 连体袜/渔网连体袜 |
| `silk slip dress under white shirt, unbuttoned collar` | 白衬衫下真丝吊带裙+解扣领 |

#### 8.6.2 泳装
| 标签 | 说明 |
|---|---|
| `bikini` / `black bikini` / `white bikini` | 比基尼/黑/白 |
| `one-piece swimsuit` / `school swimsuit` | 连体泳衣/校园泳衣 |
| `competition swimsuit` / `highleg swimsuit` | 竞技泳衣/高开叉泳衣 |
| `micro bikini` / `slingshot swimsuit` | 微型比基尼/弹弓泳衣 |
| `blue bikini` / `green sequined bikini` | 蓝色/绿色亮片比基尼 |
| `gleaming gold bikini top covered with many colorful gems` | 金比基尼+多彩宝石 |

#### 8.6.3 睡衣/家居
| 标签 | 说明 |
|---|---|
| `pajamas` / `sleepwear` | 睡衣/睡服 |
| `nightgown` / `striped nightgown` | 睡袍/条纹睡袍 |
| `negligee` / `silk robe` / `satin robe` | 晨褛/丝袍/缎袍 |
| `oversized shirt` / `boyfriend shirt` | 超大衬衫/男友衬衫 |
| `camisole` / `slip dress` | 吊带背心/吊带裙 |
| `casual sleepwear` / `cozy bedroom` | 休闲睡衣/舒适卧室 |

---

### 8.7 特殊服装/主题

#### 8.7.1 Cosplay/角色扮演
| 标签 | 说明 |
|---|---|
| `bunny girl` / `playboy bunny` / `bunny ears` / `bunny tail` | 兔女郎/兔耳/兔尾 |
| `cat girl` / `nekomimi` / `cat tail` / `bell collar` | 猫娘/猫耳/猫尾/铃铛项圈 |
| `race queen` | 赛车女郎 |
| `idol costume` / `stage costume` | 偶像服/舞台服 |
| `santa costume` / `christmas` | 圣诞装 |
| `halloween` / `demon costume` | 万圣节/恶魔装 |
| `mascot costume` / `chibi` | 吉祥物装/Q版 |

#### 8.7.2 婚纱/礼服
| 标签 | 说明 |
|---|---|
| `wedding dress` | 婚纱 |
| `white silk mermaid gown with crystal embroidery` | 白丝鱼尾婚纱+水晶刺绣 |
| `sweetheart neckline with pearl beading` | 心形领+珍珠串珠 |
| `off-shoulder lace sleeves with silver threading` | 露肩蕾丝袖+银线 |
| `10-foot cathedral train with floral appliqués` | 10英尺教堂拖尾+花卉贴花 |
| `opera-length satin gloves with button closures` | 歌剧长缎手套+扣子 |
| `thigh-high white leather boots with stiletto heels` | 过膝白皮靴+细高跟 |
| `evening gown` / `lilac evening gown` | 晚礼服/淡紫晚礼服 |

#### 8.7.3 特殊状态/改造
| 标签 | 说明 |
|---|---|
| `torn clothes` / `ripped clothes` / `damaged clothes` | 撕裂/破损衣物 |
| `torn pantyhose` / `ripped stockings` | 撕裂连裤袜/破洞袜 |
| `wet clothes` / `see-through clothes` | 湿透衣服/透视 |
| `half-dressed` / `partially undressed` | 半穿/半脱 |
| `shirt lift` / `skirt lift` / `clothes lift` | 掀衣/掀裙 |
| `off shoulder` / `shoulder slip` / `strap slip` | 露肩/肩带滑落 |
| `unbuttoned` / `open shirt` / `open jacket` | 解扣/敞衣/敞夹克 |
| `sleeves past wrists` / `sleeves past fingers` | 袖长过腕/过指 |
| `loose necktie` / `unworn hat` / `unworn shoes` | 松散领带/未戴帽/未穿鞋 |
| `one shoe missing` / `one sneaker missing` | 一只鞋不见 |

#### 8.7.4 服装细节描写
| 标签 | 说明 |
|---|---|
| `lace trim` / `bow` / `ribbon` | 蕾丝边/蝴蝶结/丝带 |
| `buttons` / `zipper` / `buckles` / `straps` | 纽扣/拉链/搭扣/绑带 |
| `embroidery` / `brocade` / `damask` | 刺绣/织锦/锦缎 |
| `sequin` / `rhinestone` / `glitter` | 亮片/水钻/闪光 |
| `pearl embellishments` | 珍珠装饰 |
| `gold trim` / `silver accents` | 金边/银点缀 |
| `fur trim` / `feathers` | 毛边/羽毛 |
| `pleats` / `frills` / `ruffles` | 褶/荷叶边/花边褶皱 |
| `layered` / `asymmetrical` | 层叠/不对称 |
| `high collar` / `detached collar` | 高领/分离领 |
| `cleavage cutout` / `navel cutout` / `side cutout` | 胸部镂空/脐镂空/侧镂空 |

---


---




### 8.8 精选搭配组合（法典精华）

> 以下为原始配方中"非直觉性"的高露出/高华丽/高细节组合
> 正常人不会一下子想到的搭配

#### 8.8.1 高露出度设计

| 标签组合 | 效果说明 |
|---|---|
| `tight black glossy bodysuit, second-skin, high-leg cut, deep v-neck chest cutout, large midriff cutout, asymmetrical off-shoulder, high side slit skirt, crimson led glow lines` | 对魔忍式战斗服：多处镂空+红色LED光线 |
| `modified black cheongsam with revealing cutouts, holding a red folding fan` | 改良镂空旗袍+红扇 |
| `white bodystocking, reverse bunnysuit, see-through, mouth mask, heart pasties, thigh strap` | 逆兔女郎连体袜：透视+口罩+心形乳贴 |
| `silk slip dress under white shirt, unbuttoned collar, black garter belt visible, one leg in sheer black stockings, other stocking rolled down to mid-thigh` | 白衬衫下吊带裙+不对称丝袜(一只卷下) |
| `torn fabric, sheer mesh, battle damage` + `abundant straps, buckles, studs` | 战后暴露：撕裂+透明网眼+丰富绑带 |
| `crotchless panties, no bra, see-through blouse` | 开裆内裤+无胸罩+透视上衣 |
| `off-shoulder sweater, pencil skirt, no panties` | 露肩毛衣+紧身裙+真空 |
| `naked apron, bottomless, cooking` | 裸体围裙+下身真空+日常动作 |
| `strapless dress, side slit, no panties, barefoot` | 无肩带裙+侧开衩+真空+赤脚 |
| `see-through skirt, miniskirt, no panties, open shirt, soaking feet` | 透视短裙+解扣衬衫+真空+泡脚 |

#### 8.8.2 华丽/奢华材质层叠

| 标签组合 | 效果说明 |
|---|---|
| `white silk mermaid gown with crystal embroidery, sweetheart neckline with pearl beading, off-shoulder lace sleeves with silver threading, 10-foot cathedral train with floral appliques, opera-length satin gloves` | 婚纱级：鱼尾水晶刺绣+10英尺拖尾+歌剧手套 |
| `edwardian-style tea dress with liquid mercury silk textures rippling under honeyed afternoon light, translucent lace gloves, intricate hair ornaments refracting prismatic rays` | 爱德华茶会裙+液态水银丝绸+棱镜发饰 |
| `moon-white silk robe with ink splashed hem, crimson inner garment peeking at collar, leather arm bracers, cloud-pattern waist sash, feathered hairpin, translucent gauze overskirt, bloodstain embroidery on sleeves` | 水墨武侠：月白丝袍泼墨+绯红内衬+血迹刺绣 |
| `liquid silk hanfu with phoenix embroidery` | 液态丝绸汉服+凤凰刺绣 |
| `lace lingerie, sheer, see-through, corset with intricate floral embroidery, high-cut lace garter belt connected to thigh-high stockings, choker necklace with dangling heart-shaped ruby pendant, long elbow gloves` | 全套情趣新娘：蕾丝透视+刺绣胸衣+吊袜带+红宝石颈链 |
| `vintage lace-trimmed silk cheongsam smoke grey with plum blossom embroidery, jade bangle, silver cicada brooch at high collar, translucent chiffon shawl` | 复古烟灰旗袍：蕾丝边+梅绣+玉镯+银蝉胸针 |
| `intricate black lace lingerie, sheer stockings layered with delicate garters, silk edges with fine embroidery, deep crimson and shadowed gold palette` | 黑蕾丝+透视袜层叠+深红暗金配色 |
| `peacock feather gorgeous dress, luxurious evening gown, top hat, gemstone necklace, lace lotus seed sleeves` | 孔雀羽礼服+高顶礼帽+宝石项链+蕾丝莲蓬袖 |

#### 8.8.3 特殊材质/概念性服装

| 标签组合 | 效果说明 |
|---|---|
| `holographic jacket, translucent synthwave visor, data-stream hair highlights, retro-futuristic shoulder pads, prismatic ankle boots` | 全息材质+合成波面罩+数据流发丝 |
| `liquid mercury drip effect, transparent pvc lapels, crystal vertebrae spine accent, magnetic floating sleeves, industrial buckle cascade` | 液态水银+PVC翻领+水晶脊椎+磁浮袖 |
| `latex, rubber, glossy, shiny, second skin, corset, high heels, opera gloves` | 乳胶第二层皮肤全套 |
| `transparent glass face shield, dark see-through glass mask covered face, screen on face, cables wires batteries screws, exposed mechanical components` | 透明面罩+透视面具+机械内脏外露 |
| `starry sky print on clothes, armored dress, breastplate, pauldrons, fantasia sword regalia` | 星空印花+装甲裙+幻想剑饰 |
| `glowing circuit patterns, neon trim, geometric design, reflective, spiral skirt, energy wings` | 发光电路纹+霓虹镶边+螺旋裙+能量翼 |

#### 8.8.4 服装改造/破坏状态

| 标签组合 | 效果说明 |
|---|---|
| `torn school uniform, white blouse with ripped collar, navy pleated skirt, knee-high socks sliding down, one shoe missing, backpack straps hanging loose` | 破损校服全套：破领+袜滑+丢鞋+包带松 |
| `wet clothes, see-through, damp hair, fabric clinging to skin` | 湿透透视：衣物贴身+湿发 |
| `torn pantyhose, ripped stockings, asymmetrical legwear, one stocking rolled down, other intact` | 不对称破袜：一只卷下一只完好 |
| `partially undressed, shirt half unbuttoned, skirt hiked up, bra strap visible` | 半脱状态：半解扣+裙撩高+肩带露 |
| `damaged armor, cracked breastplate, torn cape, blood on weapon, scars on body` | 战后破损铠甲：裂胸甲+破斗篷+血迹+疤痕 |
| `clothes lift by self, skirt hold, shirt lift, revealing undergarment` | 自掀衣物：自己撩裙/掀衣露内衣 |

#### 8.8.5 跨风格意外搭配

| 标签组合 | 效果说明 |
|---|---|
| `sweet lolita style, pastel color palette, frilly sundress, knee-high socks, riding ferocious dinosaur with sharp teeth and armored scales, volcanic background` | 甜萝骑凶暴恐龙：粉彩褶边裙+尖牙铠鳞龙 |
| `gothic lolita, defeated low-tier enemy pose, glitchy tears vfx, broken gamepad weapon, pixel art trash mob label, torn gamer jersey` | 哥特萝莉+游戏失败画面 |
| `winter coat with fur trim, orange knit hat, holding leash, walking shiba inu in snow, footprints trailing behind` | 冬装遛狗：毛边外套+橙针织帽+柴犬 |
| `kobe bryant style jersey purple and gold number 24, headset with microphone, piloting helicopter, cockpit view, city skyline below, sunset lighting` | 科比球衣+直升机驾驶舱 |
| `racing suit, bikini, see-through, holding flag, race vehicle, confetti, starry background` | 赛车服+比基尼+透视+旗+纸屑 |
| `detective deerstalker hat, brown plaid capelet, white shirt, red bowtie, pocket watch, suspender shorts, train compartment mahogany paneling` | 侦探猎鹿帽+格子披肩+怀表+红木火车厢 |
| `fluffy oversized sweater with paw prints, pastel knee-high socks with stripes, v-sign, scattered crayons on floor` | 萌系居家：爪印超大毛衣+条纹袜+V字手势 |

#### 8.8.6 性感战斗/装甲

| 标签组合 | 效果说明 |
|---|---|
| `armor, armored bodystocking, thigh holster, rifle, combat, explosion, torn clothes, blood on body, fighting stance, night sky` | 战甲连体袜+枪套+爆炸+撕裂+血污 |
| `white warcraft armor, shoulder-mounted artillery system, transparent glass face shield, mechanical backpack with thrusters, glowing energy batteries, barcode on body` | 魔兽装甲+肩扛炮+面罩+推进器+条码 |
| `erotic death goddess costume, black bone-like corset shaped like a ribcage, matching bone thong with small skull decorations, bare legs, black strappy sandals up to the knee, riding skeletal horse, holding large scythe` | 死亡女神：肋骨形骨胸衣+骨丁字裤+骷髅马+巨镰 |
| `bikini armor, pauldrons, gauntlets, micro bikini, holding sword, battle damage` | 比基尼铠甲全套：微型比基尼+肩甲+护手+战损 |
| `extremely sexy taimanin outfit, tight black glossy bodysuit, second-skin, high-leg cut, deep v-neck chest cutout, large midriff cutout` | 对魔忍：紧身光泽连体衣+多处镂空 |

#### 8.8.7 半透/空灵/仙气

| 标签组合 | 效果说明 |
|---|---|
| `translucent silk robes flowing in stratospheric winds, hair woven with cirrus strands, bare feet dangling above cloud sea` | 平流层飘袍：半透明丝袍+卷云发丝+赤脚悬云 |
| `sheer fabrics, layered robes, floating in midair, levitation, surrounded by swirling energy, ethereal swords, glowing particles, ice crystals` | 仙侠浮空：薄纱层叠袍+悬浮+能量环绕+冰晶 |
| `white and pale blue hanfu, flowing sleeves, sheer fabrics, layered robes, cold aura, snow-capped peaks, moonlight` | 冷艳仙女：白蓝汉服+薄纱层叠+冷气+雪峰 |
| `translucent body, sitting inside a glass box, ethereal presence, surrounded by blooming yellow flowers and violet foliage` | 半透明体+玻璃盒+黄花紫叶包围 |

#### 8.8.8 服饰局部细节特写

| 标签组合 | 效果说明 |
|---|---|
| `fingerless gloves, elbow gloves, lace gloves, silk gloves, latex gloves, single glove, mismatched gloves` | 手套家族全系 |
| `garter straps, garter belt, thigh strap, leg chain with tiny barrel charm, ankle ring` | 腿部饰品系列 |
| `hair ornament, peony-shaped hairpin, feathered hairpin, crystal teardrop beads, rose-gold hairpins with silver beads, cloud-shaped earrings` | 发饰精选：牡丹簪/羽簪/水晶泪珠/玫瑰金簪 |
| `choker, bell collar, spiked collar, o-ring choker, ribbon choker, pearl choker, cross necklace, gemstone necklace, multiple layered necklaces` | 颈部饰品全套系 |
| `nail polish, black nails, blue nails, red nails, long fingernails, sharp fingernails, golden nails` | 美甲：黑/蓝/红/长甲/尖甲/金甲 |
| `body writing, tally marks, barcode tattoo, circuit tattoo, floral tattoo, arm tattoo, back tattoo, leg tattoo, shoulder tattoo` | 身体标记：文字/计数线/条码/电路/花卉 |

---

## 9. POSE & ACTION（姿态与动作层）

> 对应模板槽位：`[pose/action]`
> 内容：角色身体姿态与具体动作。从所长法典原始配方中直接提取

### 9.1 站姿

#### 9.1.1 基础站立
| 标签 | 说明 |
|---|---|
| `standing` | 站立 |
| `standing on one leg` | 单腿站立 |
| `standing with poised posture` | 端庄站立 |

#### 9.1.2 倚靠
| 标签 | 说明 |
|---|---|
| `leaning against wall` / `against wall` | 靠墙 |
| `leaning against railing` | 靠栏杆 |
| `leaning forward` | 身体前倾 |
| `leaning on table` | 靠在桌上 |

#### 9.1.3 手部姿态
| 标签 | 说明 |
|---|---|
| `hand on own hip` | 单手叉腰 |
| `hands in pockets` | 双手插袋 |
| `arms crossed` | 双臂交叉 |
| `arms behind back` | 双手背在身后 |
| `arms at sides` | 双臂垂放 |
| `arms up` | 双臂举起 |
| `arms spread wide` | 双臂张开 |
| `one hand gesturing to the side` | 单手指向一侧 |
| `hand up` | 抬手 |

### 9.2 坐姿

#### 9.2.1 基础坐姿
| 标签 | 说明 |
|---|---|
| `sitting` | 坐着 |
| `sitting on chair` | 坐椅子上 |
| `sitting on bed` | 坐床上 |
| `sitting on table` | 坐桌上 |
| `sitting on floor` | 坐地上 |
| `sitting sideways` | 侧坐 |
| `sitting cross-legged` | 盘腿坐 |
| `wariza` | 割座（日式跪坐变体，腿向一侧） |
| `kneeling` | 跪姿 |
| `squatting` | 蹲姿 |
| `crouching` | 伏身蹲 |

#### 9.2.2 手/腿配合
| 标签 | 说明 |
|---|---|
| `crossed legs` | 双腿交叉 |
| `knee up` | 单膝抬起 |
| `one leg up on chair` | 一腿搭在椅上 |
| `legs dangling` | 双腿悬空垂下 |
| `hand on own cheek` / `chin rest` | 手托腮 |
| `head rest` | 头靠某处 |

### 9.3 卧姿

| 标签 | 说明 |
|---|---|
| `lying` | 躺着 |
| `lying on back` | 仰卧 |
| `lying on stomach` | 俯卧 |
| `lying on side` | 侧卧 |
| `on bed` | 在床上 |
| `on couch` | 在沙发上 |
| `reclining` | 斜倚 |
| `lounging` | 慵懒躺靠 |
| `sprawling` | 摊开四肢躺 |

### 9.4 动态动作

#### 9.4.1 移动
| 标签 | 说明 |
|---|---|
| `walking` | 行走 |
| `running` | 奔跑 |
| `jumping` | 跳跃 |
| `leaping` | 跃起 |
| `falling` / `falling down` | 坠落/下跌 |
| `diving` | 俯冲/下潜 |
| `swimming` / `swimming upwards` | 游泳/向上游 |
| `floating` | 漂浮 |
| `flying` / `soaring` | 飞翔/翱翔 |
| `hovering` | 悬停 |
| `suspended` / `suspended mid-air` | 悬浮空中 |
| `upside-down` | 倒立/倒挂 |
| `dangling` | 悬吊 |

#### 9.4.2 转身/回头
| 标签 | 说明 |
|---|---|
| `turning around` | 转身 |
| `looking back` | 回头 |
| `over shoulder` | 回眸过肩 |
| `stepping forward` | 向前迈步 |
| `stepping out` | 迈出 |
| `mid-stride` | 行进中 |

### 9.5 战斗/攻击

| 标签 | 说明 |
|---|---|
| `fighting stance` | 战斗姿态 |
| `combat stance` | 战斗站姿 |
| `charging stance` | 冲锋姿态 |
| `action pose` | 动作姿势 |
| `drawing katana` / `drawing sword` | 拔刀 |
| `holding weapon` | 持武器 |
| `aiming` / `aiming at viewer` | 瞄准/瞄准观众 |
| `gun aimed at camera` | 枪口对镜头（FPS视角） |
| `incoming attack` | 即将攻击 |
| `punching` | 拳击 |
| `smash the ground with the sledgehammer` | 大锤砸地 |
| `firing at viewer` | 向观众开火 |
| `defeated low-tier enemy pose` | 败北姿势（游戏风） |

### 9.6 手部/手势

| 标签 | 说明 |
|---|---|
| `holding` | 手持（通用） |
| `holding out hand` / `extending hand` | 伸出手 |
| `reaching out` / `reaching towards viewer` | 伸手向观众 |
| `outstretched arm` / `outstretched right hand` | 伸出的手臂/右手 |
| `offering` | 递出/献上 |
| `pointing` / `pointing at viewer` | 指向/指向观众 |
| `hand to own mouth` / `hand covering own mouth` | 手捂嘴 |
| `finger to mouth` | 手指抵唇 |
| `finger on lips` | 手指贴唇 |
| `hand between legs` | 手放腿间 |
| `arms tightly wrapped around her bent knees` | 双臂紧抱弯膝 |
| `hugging own legs` | 抱自己的腿 |
| `clenched fists` | 握拳 |
| `hands clasped` / `hands clasped in silent prayer` | 双手合十/祈祷 |
| `both hands making v-sign near cheeks` | 双手V字手势（可爱风） |
| `peace sign` / `double v` | V字手势 |
| `one eye closed mischievous wink` | 单眼眨眼 |
| `victory pose` | 胜利姿势 |

### 9.7 双人/多人互动

| 标签 | 说明 |
|---|---|
| `face to face` | 面对面 |
| `back to back` / `back-to-back pose` | 背靠背 |
| `standing side by side` | 并肩站立 |
| `holding hands` | 牵手 |
| `hug` / `embrace` | 拥抱 |
| `leaning on each other` | 相互依靠 |
| `one pinning the other against wall` | 把对方按在墙上 |
| `carrying person` / `carrying on back` | 背人/抱人 |
| `looking at each other` / `looking at another` | 对视 |
| `hand on another's hand` | 手叠手 |
| `touching the cheek` | 轻触脸颊 |
| `whispering in ear` | 耳边低语 |

### 9.8 特殊/表现性姿态

| 标签 | 说明 |
|---|---|
| `curled up` / `fetal position` | 蜷缩/胎儿姿势 |
| `arched back` | 弓背/挺腰 |
| `body arching upward` | 身体向上弓起 |
| `presenting` | 展示式姿势 |
| `bent over` | 弯腰/俯身 |
| `stretching` | 伸懒腰/拉伸 |
| `head tilt` / `head tilted back` | 头倾斜/后仰 |
| `selfie` / `holding phone` | 自拍/拿手机 |
| `adjusting hair` / `fixing hair in front of mirror` | 整理头发/对镜理妆 |
| `holding cigarette` / `smoking` | 持烟/抽烟 |

### 9.9 道具相关动作（高频组合）

| 标签 | 说明 |
|---|---|
| `holding umbrella` | 持伞 |
| `holding book` / `reading book` / `open book` | 持书/读书 |
| `holding teacup` / `holding cup` | 持茶杯 |
| `holding sword` / `holding katana` | 持剑/武士刀 |
| `holding gun` / `holding rifle` | 持枪/步枪 |
| `holding bouquet` | 持花束 |
| `holding lantern` | 持灯笼 |
| `holding flag` | 持旗帜 |
| `holding staff` | 持法杖 |
| `holding fan` / `holding folding fan` | 持扇/折扇 |
| `holding umbrella` / `red paper umbrella` | 持伞/红纸伞 |
| `riding` / `sitting on horse` | 骑马 |
| `sitting on throne` | 坐王座 |
| `resting head on someone's chest` | 头靠在某人胸口 |

---


---

## 10. EXPRESSION & REACTION（表情与反应层）

> 对应模板槽位：`[expression/reaction]`
> 内容：面部表情 + 身体生理反应。从所长法典原始配方中提取

### 10.1 正面/愉悦

| 标签 | 说明 |
|---|---|
| `smile` | 微笑 |
| `slight smile` / `gentle smile` | 浅笑/温柔笑 |
| `happy expression` / `joyful expression` | 开心/喜悦表情 |
| `open mouth smile` | 张嘴笑 |
| `grin` | 咧嘴笑 |
| `seductive smile` | 诱惑微笑 |
| `mischievous wink with one eye closed` | 单眼调皮眨眼 |
| `sparkling eyes` | 闪闪发亮眼 |
| `triumphant smile` | 胜利微笑 |
| `light smile` / `relaxed grin` | 轻松笑/放松咧嘴 |

### 10.2 负面/痛苦

| 标签 | 说明 |
|---|---|
| `sad` / `sorrow` | 悲伤/忧伤 |
| `crying` / `tears` / `tears streaming down her face` | 哭泣/流泪/泪流满面 |
| `empty eyes` / `vacant stare` / `blank expression` | 空洞眼神/茫然凝视/空白表情 |
| `expressionless` / `no expression` | 面无表情 |
| `depressed` / `lonely` | 沮丧/孤独 |
| `melancholic mood` / `melancholic gaze` | 忧郁情绪/忧郁目光 |
| `ashamed` / `embarrassed` | 羞愧/尴尬 |
| `scared` / `terrified` / `wide bloodshot eyes` | 害怕/惊恐/布满血丝大眼 |
| `distressed expression` / `helpless and broken expression` | 痛苦表情/无助崩溃表情 |
| `frown` | 皱眉 |
| `disdain` | 不屑 |
| `disgust` | 厌恶 |

### 10.3 愤怒/激烈

| 标签 | 说明 |
|---|---|
| `angry` / `extreme anger` | 愤怒/极度愤怒 |
| `fierce expression` / `intense gaze` | 凶狠表情/强烈凝视 |
| `determined expression` / `resolute` | 坚定表情/坚决 |
| `serious expression` / `stern expression` | 严肃表情/严厉表情 |
| `ice-cold killer expression` | 冰冷杀手表情 |
| `bloodthirsty smirk` | 嗜血冷笑 |
| `red face` / `veins popping` / `clenched teeth` | 脸红/血管暴起/咬紧牙 |
| `steam coming from head` | 头上冒蒸汽（漫画怒） |
| `shouting` / `screaming` | 喊叫/尖叫 |

### 10.4 诱惑/魅惑

| 标签 | 说明 |
|---|---|
| `seductive` / `alluring smile` | 诱惑/迷人微笑 |
| `half-lidded eyes` / `half-closed eyes` | 半闭眼/慵懒眼 |
| `looking at viewer seductively` | 诱惑凝视观众 |
| `parted lips` / `slightly parted lips` | 微张双唇 |
| `tongue out` / `tongue slightly sticking out` | 伸舌/微伸舌 |
| `licking lips` | 舔唇 |
| `finger to mouth` / `finger on lips` | 手指抵唇 |
| `biting lower lip` | 咬下唇 |
| `smirk` / `smug` | 得意笑/自满 |

### 10.5 失神/过激

| 标签 | 说明 |
|---|---|
| `ahegao` | 阿黑颜 |
| `rolling eyes` / `eyes rolled back` | 翻白眼/眼白外翻 |
| `tongue out` / `drooling` | 伸舌/流口水 |
| `fucked silly` | 被操傻 |
| `mind break` | 精神崩坏 |
| `torogao` | 融化的表情 |
| `heart-shaped pupils` | 心形瞳孔 |
| `cross-eyed` | 对眼/斗鸡眼 |
| `foaming at the mouth` | 口吐白沫 |
| `heavy breathing` / `panting` | 粗重呼吸/喘息 |
| `sweat` / `sweating profusely` / `sweat-drenched` | 汗/大汗/汗湿 |

### 10.6 平静/中性

| 标签 | 说明 |
|---|---|
| `calm` / `serene expression` | 平静/安详表情 |
| `expressionless` / `emotionless` | 面无表情/无情绪 |
| `closed eyes` / `sleeping peacefully` | 闭眼/安睡 |
| `sleepy` / `half-asleep` | 困倦/半睡 |
| `cool` / `composed` / `confident` | 冷酷/沉着/自信 |
| `quiet` / `silent` | 安静/静默 |
| `aloof` / `distant` | 超然/疏远 |
| `bored` / `looking at phone` | 无聊/看手机 |

### 10.7 惊讶/好奇

| 标签 | 说明 |
|---|---|
| `surprised` / `astonished` | 惊讶/惊愕 |
| `shocked` | 震惊 |
| `wide-eyed` | 瞪大眼 |
| `curious` / `curious expression` | 好奇/好奇表情 |
| `nervous` / `worry` / `worried` | 紧张/担忧 |

### 10.8 身体生理反应

| 标签 | 说明 |
|---|---|
| `blush` / `full-faced blush` / `nose blush` | 脸红/全脸红/鼻红 |
| `sweat` / `sweat drops` / `sweating profusely` | 汗珠/大汗淋漓 |
| `trembling` / `shaking` | 颤抖/发抖 |
| `goosebumps` | 鸡皮疙瘩 |
| `tears` / `tear streaks` / `mascara streak` | 泪/泪痕/睫毛膏花 |
| `visible breath vapor` | 可见呼吸白气（冷环境） |
| `steaming body` | 身体冒热气 |
| `arched back` / `body arching upward` | 弓背/身体上拱 |
| `toes curling` | 脚趾蜷曲 |
| `veins` / `veins protruding` | 血管/血管凸起 |
| `bruise` / `scar` / `wound` | 淤青/伤疤/伤口 |
| `blood on face` / `blood everywhere` | 脸上血迹/满身血 |
| `dirty body` / `covered in filth and grime` | 脏污身体/满身污秽 |

---

*标签库全部完成。*


## 11. CAMERA & SHOT（镜头构图与视角层）

> 对应模板槽位：`[camera/shot]`
> 仅包含：景别、视角方向、角度、对焦景深、构图原则、分镜
> 不包含：画面渲染效果（→ `[detail/mood]`）、姿态动作（→ `[pose/action]`）

### 11.1 景别（Shot Size）

| 标签 | 说明 |
|---|---|
| `extreme close-up` | 极致特写（脸部/眼睛/武器） |
| `close-up` | 标准特写 |
| `close-up on weapon` | 武器特写 |
| `close-up on head` | 头部特写 |
| `face focus` | 面部聚焦 |
| `upper body` | 上半身 |
| `portrait` | 肖像构图 |
| `bust shot` / `bust-up` | 胸像 |
| `cowboy shot` | 牛仔镜头（胯以上，最常用中景） |
| `medium shot` | 中景 |
| `full body` | 全身 |
| `wide shot` | 广景 |
| `extreme long shot` | 极远景 |

### 11.2 视角方向

| 标签 | 说明 |
|---|---|
| `from front` / `front view` | 正面 |
| `from side` / `side view` | 侧面 |
| `from behind` / `back view` | 背面 |
| `from above` | 俯视 |
| `from below` | 仰视 |
| `looking at viewer` | 直视观众 |
| `facing viewer` | 面向观众 |
| `looking away` | 看向别处 |
| `looking back` | 回头 |
| `looking down` | 俯视下方 |
| `looking up` | 仰视上方 |
| `looking afar` | 望远 |
| `looking at another` | 看向另一人 |
| `facing away` | 背对 |
| `facing another` | 面向另一人 |

### 11.3 特殊视角

| 标签 | 说明 |
|---|---|
| `pov` | 第一人称视角 |
| `pov hands` | POV+手入镜 |
| `pov crotch` | POV胯部视角 |
| `first-person perspective` | 第一人称 |
| `from outside` / `through window` | 窗外向内看 |
| `view from outside window` | 经典"窗外窥视" |
| `from bed` | 从床上视角 |
| `peeping` / `hidden camera` | 偷窥/隐藏摄像头 |
| `over shoulder` | 过肩视角 |
| `from behind over shoulder` | 背身过肩 |
| `three-quarter view` | 四分之三侧面 |
| `profile` | 纯侧面 |
| `straight-on` | 正对 |

### 11.4 角度与镜头效果

| 标签 | 说明 |
|---|---|
| `dutch angle` | 荷兰角（倾斜构图） |
| `45-degree tilted dutch angle camera` | 45度荷兰角 |
| `low angle` / `low-angle shot` | 低角度 |
| `extreme low-angle shot from ground perspective` | 极低地平面角度 |
| `high angle` / `from high angle` | 高角度俯视 |
| `bird's eye view` | 鸟瞰 |
| `aerial view` | 航拍视角 |
| `overhead` / `from above direct overhead` | 正上方 |
| `dynamic angle` | 动态角度 |
| `cinematic angle` | 电影级角度 |
| `dramatic perspective distortion` | 戏剧性透视扭曲 |
| `fisheye` / `fisheye lens effect` | 鱼眼效果 |
| `ultra wide angle` | 超广角 |
| `macro` | 微距 |

### 11.5 对焦与景深

| 标签 | 说明 |
|---|---|
| `depth of field` | 景深 |
| `shallow depth of field` | 浅景深 |
| `extreme shallow depth of field` | 极浅景深 |
| `out of focus foreground` | 前景虚化 |
| `background in sharp focus` | 背景清晰对焦 |
| `background softly blurred` | 背景柔和虚化 |
| `soft focus` | 柔焦 |
| `bokeh` | 散景光斑 |
| `sharp focus` | 清晰对焦 |
| `focus on face` | 面部对焦 |
| `eye focus` | 眼部对焦 |

### 11.6 运动效果（仅摄影级）

| 标签 | 说明 |
|---|---|
| `motion blur` | 运动模糊（摄影技法） |
| `motion blur on outstretched arm` | 局部运动模糊 |
| `multiple overlapping motion blurs` | 多重运动模糊叠加 |
| `camera shake effect` | 手持相机抖动感 |

### 11.7 构图原则

| 标签 | 说明 |
|---|---|
| `asymmetrical composition` | 不对称构图 |
| `diagonal composition` | 对角线构图 |
| `off-center framing` | 偏离中心取景 |
| `centered composition` | 居中构图 |
| `golden ratio composition` | 黄金比例构图 |
| `rule of thirds` | 三分法 |
| `negative space` / `80% negative space` | 负空间/留白 |
| `dynamic composition` | 动态构图 |
| `cinematic composition` | 电影级构图 |
| `cinematic framing` | 电影取景 |
| `cinematic aspect ratio 2.35:1` | 宽银幕比例 |
| `letterbox` / `widescreen` | 信箱/宽屏 |

### 11.8 透视与画面关系

| 标签 | 说明 |
|---|---|
| `body leaning forward` | 身体前倾（增强冲击力，构图技法） |
| `foreshortening` | 透视缩短 |
| `extreme foreshortening perspective` | 极端透视缩短 |
| `vanishing point` | 消失点构图 |

### 11.9 多画面/分镜

| 标签 | 说明 |
|---|---|
| `split screen` / `split theme` | 分屏 |
| `2koma` / `4koma` | 二格/四格漫画 |
| `before and after` | 前后对比 |
| `2views` / `multiple views` | 多视角 |
| `symmetry` | 对称构图 |
| `white line dividing screen from center` | 中轴线分屏 |



---

## 12. SCENE & LOCATION（场景环境层）

> 对应模板槽位：`[scene/location]`
> 内容：场景中**客观存在**的元素 — 地点、建筑、自然景观、天气现象、时辰
> 不含：光照质感/风格（→ `[detail/mood]`）、渲染特效（→ `[detail/mood]`）

---

### 12.1 赛博朋克 / 科幻

#### 12.1.1 城市景观
| 标签 | 效果倾向  | |
|---|---|---|
| `cyberpunk cityscape` | 标准赛博都市全景 |
| `sprawling cityscape of towering dark skyscrapers` | 摩天楼丛林、压抑感 |
| `neon-lit alleyway` | 霓虹巷道、亲密窄空间 |
| `rain-soaked neon alleyway` | 雨后反光地面+霓虹、经典赛博 |
| `city lights below` / `city skyline below` | 高处俯视城市灯光 |
| `glowing windows in shades of blue orange and purple` | 彩色发光窗户矩阵 |
| `smog-choked air` | 雾霾弥漫、压迫感 |
| `sickly glow of corporate logos` | 商业标识病态光芒、反乌托邦 |
| `holographic billboards flicker` | 全息广告牌闪烁 |
| `flickering neon lights` | 闪烁霓虹 |
| `destroyed cyberpunk city background in jagged line art` | 锯齿线稿风赛博废墟 |
| `convenience store neon backdrop` | 便利店霓虹背景 |

#### 12.1.2 室内/工业
| 标签 | 效果倾向  | |
|---|---|---|
| `dark and eerie machinery factory` | 黑暗诡异机械工厂 |
| `ruined industrial zone with broken metal structures` | 废墟工业区、破碎金属结构 |
| `collapsed concrete walls and shattered machinery` | 倒塌混凝土墙+破碎机械 |
| `rocket turrets and mechanical devices emit steam and glowing sparks` | 炮塔蒸汽火花 |
| `collapsing industrial pipelines` | 坍塌工业管道 |
| `abandoned post-apocalyptic setting` | 后末日废弃感 |

#### 12.1.3 科幻/太空
| 标签 | 效果倾向  | |
|---|---|---|
| `dark spaceship cabin` / `mechanical seat` | 黑暗太空舱/机械座椅 |
| `large transparent cylindrical sci-fi culture tank` | 大型透明培养槽 |
| `glowing light purple fluid` | 发光淡紫色液体（培养液） |
| `transparent glass face shield` / `screen on face` | 面罩/HUD屏显 |
| `laboratory` / `machinery factory` | 实验室/机械工厂 |
| `blank white void background` | 空白虚空背景（赛博格展示用） |

#### 12.1.4 赛博氛围词
| 标签 | 说明 |
|---|---|
| `neon arteries pulse with data streams` | 数据流霓虹动脉感 |
| `cyan haze` | 青色雾霾 |
| `electric blue glow` | 电蓝色辉光 |
| `neon pink and blue lighting` | 霓虹粉蓝双色光 |
| `digital glitch effects` / `scan lines` | 数字故障/扫描线 |
| `vhs distortion with tracking errors` | VHS失真 |
| `floating digital glitch particles` | 浮空数字故障粒子 |
| `reflective wet pavement` | 湿路面反射 |
| `acid rain droplets` | 酸雨滴 |
| `deep purple fog` | 深紫雾 |

---

### 12.2 古风 / 东方

#### 12.2.1 建筑/园林
| 标签 | 效果倾向  | |
|---|---|---|
| `traditional chinese architecture` | 中式建筑通用 |
| `red wooden pavilion` | 红木亭阁 |
| `ornate oriental garden` | 华丽东方园林 |
| `traditional lattice window` | 传统格子窗 |
| `wooden veranda overlooking a river` | 木制阳台俯视河景 |
| `cobblestone path leading to red torii gate` | 石板路通往鸟居 |
| `ancient shrine` | 古老神社 |
| `torii gate in background` | 背景鸟居 |
| `red torii gate` | 红色鸟居 |
| `stone lantern with faint blue flame` | 石灯笼微蓝火焰 |
| `paper lanterns hanging from tree branches` | 树枝悬挂纸灯笼 |
| `hanging lanterns with tassels` | 带流苏的悬挂灯笼 |

#### 12.2.2 自然山水
| 标签 | 效果倾向  | |
|---|---|---|
| `mist-shrouded peaks` | 云雾笼罩的山峰 |
| `ink-wash mountains fading in mist` | 水墨远山隐于雾中（经典配方） | B1/B10 |
| `distant mountains with layered ink wash effect` | 远山层叠水墨效果 |
| `mountain stream` / `winding mountain stream` | 山涧/蜿蜒溪流 |
| `pine forests` | 松林 |
| `bamboo groves` / `bamboo grove with colorful tanzaku strips` | 竹林/七夕竹签 |
| `willow trees` / `willow branches dripping onto stone bridge` | 柳树/柳枝滴水石桥 |
| `maple leaves` / `soft sunlight filtering through maple leaves` | 枫叶/柔光透枫叶 |
| `cherry blossoms` / `falling cherry blossom petals` | 樱花/落樱 |
| `peonies` | 牡丹 |
| `lotus pond` / `lotus pond reflection` | 荷塘/荷塘倒影 |
| `koi pond reflections with floating lotus pods` | 锦鲤池倒影+莲蓬 |
| `dew drops on bamboo leaves` / `dew drops on spider webs` | 竹叶露珠/蛛网露珠 |

#### 12.2.3 水域
| 标签 | 效果倾向 |
|---|---|
| `crystal-clear water reflecting sunlight` | 清澈水面反射阳光 |
| `green lake` | 碧绿湖水（清明主题） |
| `reflective turquoise water` | 反射性碧绿海水 |
| `water ripple distortion underfoot` | 脚下水波扭曲 |

#### 12.2.4 天气/时辰
| 标签 | 效果倾向  | |
|---|---|---|
| `morning mist` / `dense fog swirling around wooden bridge` | 晨雾/浓雾环绕木桥 |
| `drizzling tomb-sweeping rain` | 清明细雨（极具体） |
| `soft morning light filtering through willow trees` | 晨光透柳树 |
| `moonlit night` | 月夜 |
| `soft sunlight filtering through trees` | 柔光透树 |
| `golden hour glow` | 黄金时刻光芒 |
| `faint mist` | 淡薄雾 |

#### 12.2.5 古风氛围词
| 标签 | 说明 |
|---|---|
| `ink splash` / `calligraphic brushstrokes` | 泼墨/书法笔触 |
| `poetic atmosphere` | 诗意氛围 |
| `serene landscape embodying harmony between humanity and nature` | 天人合一 |
| `classical composition with balanced elements` | 古典平衡构图 |
| `watercolor texture` | 水彩质感 |

---

### 12.3 哥特 / 暗黑 / 恐怖

#### 12.3.1 建筑/废墟
| 标签 | 效果倾向  | |
|---|---|---|
| `decaying gothic ruins` | 腐朽哥特废墟 |
| `crumbling stone walls covered in glowing moss` | 崩裂石墙覆盖发光苔藓 |
| `shattered stained-glass fragments embedded in ancient pillars` | 破碎彩绘玻璃嵌入古柱 |
| `collapsed clock towers` | 倒塌钟楼 |
| `moss-covered tombstones` | 苔藓覆盖墓碑 |
| `decrepit haunted mansion interior` | 破旧鬼屋内部 |
| `peeling victorian wallpaper` | 剥落维多利亚墙纸 |
| `collapsing wooden floorboards` | 坍塌木地板 |
| `broken chandeliers hanging from ceiling` | 破碎吊灯悬挂 |
| `thick cobwebs covering furniture` | 厚蛛网覆盖家具 |
| `rotting wooden beams` | 腐朽木梁 |
| `slimy mold on walls` | 墙壁黏滑霉菌 |
| `ancient tombstones loom ominously` | 古老墓碑阴森耸立 |

#### 12.3.2 天气/大气
| 标签 | 效果倾向  | |
|---|---|---|
| `pale moonlight` | 苍白月光 |
| `eerie blue mist blankets the forest floor` | 诡异蓝雾笼罩林地 |
| `green mist permeating air` | 绿色鬼雾弥漫 |
| `flickering candlelight casting dancing shadows` | 摇曳烛光投射舞动阴影 |
| `deep ominous shadows` | 深邃不祥阴影 |
| `moonlight piercing through shattered windows` | 月光穿透破碎窗户 |
| `intense volumetric fog` | 强烈体积雾 |
| `ghostly floating orbs` | 幽灵浮空球体 |
| `suspenseful horror atmosphere` | 悬疑恐怖氛围 |
| `dark foreboding wasteland` | 黑暗不祥荒地 |
| `stormy sky lit by flashes of lightning` | 闪电照亮暴风雨天空 |

---

### 12.4 自然 / 户外

#### 12.4.1 天空/气象（高价值组合）
| 标签 | 说明  | |
|---|---|---|
| `bright cloud-dappled sky` | 明亮白云点缀天空 |
| `clear azure sky dotted with fluffy white clouds` | 湛蓝天空蓬松白云 |
| `deep star-speckled sky with wisps of dark clouds` | 深空繁星+缕缕乌云 |
| `gradient twilight sky` | 渐变暮色天空 |
| `warm golden hour light washes over the landscape` | 黄金时刻光洒大地 |
| `stormy sky` / `lightning strike illumination` | 暴风雨/雷击照明 |
| `snowfield` / `snowstorm` / `arctic` | 雪原/暴风雪/极地 |
| `blizzard` | 暴风雪 |

#### 12.4.2 水域
| 标签 | 说明 |
|---|---|
| `tranquil bay` | 宁静海湾 |
| `turquoise water` / `clear turquoise water` | 碧绿清水 |
| `waterfall` / `splashing water` | 瀑布/溅水 |
| `waves crashing against rocks` | 海浪拍岩 |
| `sun's reflection creates a dazzling path of light across the water's surface` | 日光反射水面光路 |
| `underwater` / `bubbles` | 水下/气泡 |

#### 12.4.3 山川/田野
| 标签 | 说明  | |
|---|---|---|
| `distant rolling mountains blend with clear azure sky` | 远山融入蓝天 |
| `barren hills` / `abandoned wagon` | 荒丘/废弃马车 |
| `snow-capped peaks` / `glacier` | 雪峰/冰川 |
| `flower field` / `vast field of white wildflowers` | 花田/白色野花田 |
| `golden rice paddies` | 金色稻田 |
| `wheat field` | 麦田 |
| `vibrant green fields` | 生机绿野 |

#### 12.4.4 植物微观
| 标签 | 说明 |
|---|---|
| `dappled sunlight filtering through leafy canopy` | 斑驳阳光透叶冠 |
| `delicate petals glow under diffused sunlight` | 花瓣散射光下发光 |
| `dense tropical foliage` | 浓密热带植物 |
| `moss-covered stone steps` | 苔藓石阶 |
| `clusters of bioluminescent flowers` | 生物发光花簇 |

---

### 12.5 室内 / 日常

#### 12.5.1 家居
| 标签 | 说明  | |
|---|---|---|
| `cozy bedroom` / `soft morning sunlight` | 舒适卧室/柔晨光 |
| `wooden bedframe` / `fluffy pillows` | 木床架/蓬松枕头 |
| `rumpled bedsheets` | 凌乱床单 |
| `bathroom` / `modern bathroom` | 浴室/现代浴室 |
| `wooden floor` / `carpet` / `tatami` | 木地板/地毯/榻榻米 |
| `window` / `floor-to-ceiling window` / `french window` | 窗/落地窗/法式窗 |
| `lace curtains` | 蕾丝窗帘 |
| `mirror` / `reflection on the wall` | 镜子/墙上反射 |
| `antique furniture` / `antique brass desk lamp` | 古董家具/黄铜台灯 |

#### 12.5.2 公共/商业
| 标签 | 说明  | |
|---|---|---|
| `quiet backstreet café` | 安静后街咖啡馆 |
| `wooden table` / `ceramic mug` | 木桌/陶瓷杯 |
| `vintage wooden bookshelf filled with leather-bound books` | 复古书架+皮面书 |
| `library` / `bookshelves` | 图书馆/书架 |
| `classroom` / `chalkboard with doodles` | 教室/涂鸦黑板 |
| `office` / `mahogany desk` | 办公室/红木桌 |
| `train compartment` / `rich mahogany wood paneling` | 火车车厢/红木镶板 |
| `brass fixtures and rivets` | 黄铜固定件和铆钉 |
| `velvet upholstered seats` | 天鹅绒软垫座椅 |
| `small hobby/model kit store` | 模型商店 |
| `messy room` / `slightly disorganized and relaxed` | 凌乱房间日常感 |

#### 12.5.3 装饰/道具
| 标签 | 说明 |
|---|---|
| `scattered crayons` / `crayon boxes` | 散落蜡笔/蜡笔盒 |
| `chalkboard with doodles` | 涂鸦黑板 |
| `pizza box` / `slice of pizza` | 披萨盒（日常沉浸感） |
| `laptop` | 笔记本电脑 |
| `vinyl record player` / `old jazz tune` | 唱片机/老爵士 |



---

### 12.6 奇幻 / 异世界

#### 12.6.1 仙幻场景
| 标签 | 说明  | |
|---|---|---|
| `wonderland valley` | 仙境山谷 |
| `floating crescent moon` | 浮空新月 | B10 |
| `cloud sea` / `above cloud sea` | 云海/云海之上 | B10 |
| `rippling nimbus clouds` | 涟漪雨云 | B10 |
| `birds flying below her position` | 鸟在她下方飞翔（高空感） | B10 |
| `waterfall` / `rockery` | 瀑布/假山 |
| `ancient stone pillars` / `glowing blue runes` | 古石柱/发光蓝符文 |
| `massive circular portal emitting faint golden light` | 巨大圆形传送门散发金光 |

#### 12.6.2 黑暗奇幻
| 标签 | 说明  | |
|---|---|---|
| `dark foreboding wasteland` | 黑暗不祥荒地 |
| `cracked earth glows with ancient runes` | 龟裂大地发光符文 |
| `swirling vortex of green mist and energy` | 绿雾能量漩涡 |
| `volcanic crater` / `glowing river of lava` | 火山口/发光熔岩河 |
| `obsidian rocks` / `swirling embers` | 黑曜岩/旋转余烬 |
| `molten rock` / `lava cascading` | 熔岩/熔岩倾泻 |

#### 12.6.3 异空间/维度
| 标签 | 说明 |
|---|---|
| `dimensional rift` | 维度裂隙 |
| `digital deconstruction surrealism` | 数字解构超现实 |
| `half-autumn park bench / half-cyberspace grid` | 半秋公园椅/半赛博网格 |
| `reality fracture between figures` | 人物间现实断裂 |
| `shattered mirror background` | 破碎镜子背景 |

---

### 12.7 战斗 / 废墟

| 标签 | 说明  | |
|---|---|---|
| `ruins` / `ruined cityscape` | 废墟/废墟城市 |
| `collapsed buildings` / `cracked concrete` | 倒塌建筑/龟裂混凝土 |
| `scattered debris` / `debris flying around` | 散落碎片/碎片飞溅 |
| `explosions and smoke create chaos` | 爆炸烟雾制造混乱 |
| `damaged rocket parts and twisted pipes` | 损坏火箭部件+扭曲管道 |
| `burning plains` | 燃烧平原 |
| `battlefield` / `war` | 战场/战争 |
| `rubble` / `smoke` | 瓦砾/烟雾 |
| `ground cracking with neon light emission` | 地裂+霓虹光射 |

---

---

## 13. DETAIL & MOOD（氛围与渲染层）

> 对应模板槽位：`[detail/mood]`
> 内容：画面**看起来的质感与氛围** — 光照风格、画面纹理、数字/漫画特效、光学效果
> 不含：场景地点/天气（→ `[scene/location]`）、景别/构图（→ `[camera/shot]`）

### 13.1 灯光氛围

| 标签 | 说明 |
|---|---|
| `soft gas lamp glow` | 柔和煤气灯暖光（复古车厢/室内） |
| `warm sepia undertones` | 暖棕褐底色（怀旧感） |
| `dim ambient lighting` | 昏暗环境光（私密/恐怖） |
| `soft indoor lighting` | 柔和室内光（温馨日常） |
| `candlelight` | 烛光 |
| `flickering candlelight` | 摇曳烛光（哥特/浪漫） |
| `dramatic lighting` | 戏剧性打光 |
| `cinematic lighting` | 电影级打光 |
| `high-contrast lighting` | 高对比打光 |
| `low-key lighting` | 低调光（暗黑题材） |
| `high key lighting` | 高调光（明亮清新） |
| `chiaroscuro` | 明暗对照（经典油画光） |
| `rim light` / `rim lighting` | 轮廓光（勾勒人物边缘） |
| `backlight` / `backlighting` | 背光 |
| `strong backlight` | 强背光 |
| `cinematic rim lighting` | 电影级轮廓光 |
| `anime-style rim lighting` | 动漫风轮廓光 |
| `dappled sunlight` | 斑驳阳光（透过树叶/蕾丝） |
| `soft diffused light` | 柔和漫射光 |
| `volumetric light beams` | 体积光束（可见光柱） |
| `god rays` | 圣光/丁达尔效应 |
| `light particles` / `floating light particles` | 浮空光粒子 |
| `glowing particles` | 发光粒子 |

### 13.2 画面质感

| 标签 | 说明 |
|---|---|
| `film grain` / `heavy film grain overlay` | 胶片颗粒感 |
| `vintage film grain overlay` | 复古胶片颗粒 |
| `emulsion scratch texture` | 胶片乳剂划痕 |
| `soft focus` | 柔焦 |
| `soft-focus rain blending traffic light bokeh` | 雨夜柔焦+交通灯散景 |
| `dreamcore atmosphere` | 梦核氛围 |
| `ethereal atmosphere` | 空灵氛围 |
| `painterly` | 绘画质感 |
| `watercolor texture` | 水彩纹理 |
| `ink wash` | 水墨渲染 |
| `sketch` / `lineart` | 素描/线稿 |
| `black and white monochrome` | 黑白单色 |
| `greyscale` | 灰度 |
| `spot color` / `limited palette` | 专色/限色调色板 |
| `limited 16-color palette` | 16色限定（像素风） |
| `gridded paper` / `blueprint` | 网格纸/蓝图风 |
| `halftone dots shading with screentone patterns` | 网点阴影+网纹纸（漫画风） |
| `ink splatter border` | 喷墨边框（漫画风） |
| `comic-style` | 漫画风格线 |
| `scribbly shading` | 潦草排线 |

### 13.3 数字/故障效果

| 标签 | 说明 |
|---|---|
| `chromatic aberration` | 色差/紫边 |
| `glitch art effects` | 故障艺术 |
| `digital glitch effects` | 数字故障 |
| `scan lines` / `CRT scanlines` | 扫描线/CRT效果 |
| `vhs distortion with tracking errors` | VHS失真+跟踪错误 |
| `pixelated outlines` | 像素化轮廓 |
| `blocky pixelated texture` | 块状像素纹理 |
| `multiple exposure effect` | 多重曝光 |
| `RGB split effect` | RGB分色效果 |
| `data stream effects` | 数据流效果 |
| `binary code particles` | 二进制代码粒子 |

### 13.4 漫画/运动渲染

| 标签 | 说明 |
|---|---|
| `speed lines` | 速度线（漫画/动画风） |
| `motion lines` | 运动线 |
| `motion feel` | 运动感暗示 |
| `dynamic motion trails` | 动态运动轨迹 |
| `wind-blown` / `wind effect on hair` | 风吹动感 |

### 13.5 光学特效

| 标签 | 说明 |
|---|---|
| `lens flare` / `lens flare streaks` | 镜头光晕/光晕条纹 |
| `bloom` | 辉光溢出 |
| `crushed shadows + blown highlights` | 压碎阴影+过曝高光 |
| `silhouette` / `backlit silhouette` | 剪影/背光剪影 |
| `reflection` / `mirror reflection` | 反射/镜像 |
| `vignette` | 暗角 |

---

## 14. 重跑/改图时怎么改prompt（来源：AI-KSK）

已有满意底图，只换剧情不换画风时：

| 保留（不动） | 可改 | 重写 |
|---|---|---|
| 风格锚点 + 角色外观 + 镜头框架 | 身份设定 / 关键道具 / 背景冲突 | 最后一句自然语言（新动作+新冲突+新观众关系） |

---

## 15. ASSEMBLY DECISION TREE

根据场景类型，按槽位顺序填充。每种类型给出推荐侧重和镜头搭配。

### 15.1 单人展示类

```
[count/gender] → [appearance] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [detail/mood] → [natural language]
```

| 槽位 | 侧重 |
|---|---|
| appearance | 发型+瞳色+体型必填，非人特征按需 |
| clothing | 选1-2件核心服装+1个材质，不需要写全身 |
| pose | 站姿/坐姿选一，视线方向必填（单人不指定=看镜头） |
| expression | 选一个主表情，搭配场景情绪 |
| camera | 展示全身用`full body, from front`；强调局部用`close-up` + 对应`X focus`；诱惑感用`cowboy shot, from below` |
| scene | 主场所+1个环境元素，简约背景用`simple background` |

### 15.2 单人动态/战斗类

```
[count/gender] → [appearance] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [detail/mood] → [natural language]
```

| 槽位 | 侧重 |
|---|---|
| clothing | 优先战斗服/铠甲/战术装，可加战损(`torn` `damaged` `battle damage`) |
| pose | 必须选动态动作（`running` `jumping` `fighting stance` `swinging sword`），加运动效果 |
| expression | 坚定/凶狠/专注类表情优先 |
| camera | 动态用`from side, full body`或`dutch angle`增加张力；特写武器用`close-up on weapon` |
| scene | 战场/废墟/工业区，加烟雾/爆炸/碎片等氛围 |

### 15.3 双人互动类

```
[count/gender] → [character/series] → [appearance_A] → [appearance_B] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [natural language]
```

| 槽位 | 侧重 |
|---|---|
| appearance | 每个角色至少写3个外观锚点（发色+瞳色+一个特征），防止模型混淆 |
| clothing | 两人服装要有区分度（色系/风格差异），除非刻意统一 |
| pose | 必须写互动动作（`face to face` `back to back` `holding hands` `hug`），自然语言补充"谁对谁做什么" |
| expression | 两人表情可以不同（如A坚定B担忧），自然语言说清 |
| camera | 并肩用`from side, full body`；对话用`cowboy shot`；亲密用`close-up` |
| scene | 场景要容纳两人空间，优先中远景 |

### 15.4 多人/群像类

```
[count/gender] → [各角色外观] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [natural language]
```

| 槽位 | 侧重 |
|---|---|
| count/gender | 精确人数，如`3girls, multiple girls` |
| appearance | 每个角色≥3个外观锚点，避免模型串脸 |
| pose | 群像用`standing side by side`或分组互动；自然语言描述站位关系 |
| camera | 多人优先`from above`或`full body`容纳所有人；`wide shot`展示全景 |
| scene | 必须能容纳全员的场景，优先户外/大空间 |

### 15.5 剧情主视觉类（Key Visual）

```
[count/gender] → [appearance] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [detail/mood] → [natural language]
```

| 槽位 | 侧重 |
|---|---|
| clothing | 重点服装+材质细节，主视觉需要服装有辨识度 |
| pose | 身体前倾(`body leaning forward`)增强冲击力，道具递向镜头 |
| expression | 与观众关系匹配（邀请→温柔/挑衅→自信/审判→冷酷） |
| camera | `cowboy shot` + `body leaning forward` + `anime key visual` |
| scene | 必须有冲突背景（暴雨/警报/封印破裂等），见§3五步法 |
| natural language | 必须包含：身份+动作+冲突+观众关系，一句话能讲故事 |

### 15.6 日常/生活类

```
[count/gender] → [appearance] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [detail/mood] → [natural language]
```

| 槽位 | 侧重 |
|---|---|
| clothing | 日常服装为主（毛衣/校服/T恤+裤），避免华丽材质 |
| pose | 自然动作（散步/看书/做饭/喝咖啡），不过度设计 |
| expression | 平静/温柔/轻松类，不需要强烈表情 |
| camera | `cowboy shot`或`medium shot`保留生活感，避免极端角度 |
| scene | 日常场所（咖啡馆/卧室/教室/街道），强调道具细节（杯子/书/食物） |

### 15.7 奇幻/异世界类

```
[count/gender] → [appearance] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [detail/mood] → [natural language]
```

| 槽位 | 侧重 |
|---|---|
| appearance | 非人特征必填（翅膀/角/耳/尾），魔幻/仙侠/异种各有体系 |
| clothing | 魔法袍/铠甲/仙裙/异族服饰，可加发光特效材质 |
| pose | 浮空/飞翔/施法/召唤，加魔法特效动作 |
| expression | 神圣/神秘/威严/空灵 |
| camera | 广角展示世界观，低角度增加史诗感 |
| scene | 仙境/异空间/魔法阵/火山/龙骨，配合光粒子/符文/能量效果 |

### 15.8 Cosplay/角色扮演类

```
[count/gender] → [character/series] → [appearance] → [clothing/state] → [pose/action] → [expression/reaction] → [camera/shot] → [scene/location] → [natural language]
```

| 槽位 | 侧重 |
|---|---|
| character/series | 必须写角色名+作品名 |
| appearance | ≥5个外观锚点（精确到发色/发型/瞳色/标志性特征），IP角色还原度靠这个 |
| clothing | 标志性服装+≥3个符号元素（配饰/图案/道具） |
| pose | 符合角色性格的姿势（角色固有pose优先） |
| scene | 角色世界观场景，增加代入感 |
| 恶堕类 | 原角色属性+`corrupted` `fallen` `dark`=最强反差 |

---

## 16. CONFLICT TABLE

输出前必须逐项检查。以下冲突标签对**不可同时出现**。

### 16.1 视角互斥

| 标签A | 标签B | 原因 |
|---|---|---|
| `from front` | `from behind` | 物理矛盾 |
| `from above` | `from below` | 物理矛盾 |
| `looking at viewer` | `facing away` | 视线矛盾 |
| `pov` | `full body` | POV不可能看到自己全身 |
| `close-up` | `full body` | 景别矛盾 |
| `bird's eye view` | `from below` | 角度矛盾 |

### 16.2 身份互斥

| 标签A | 标签B | 原因 |
|---|---|---|
| `solo` | `1boy` / `2girls` / `multiple girls` | 单人不存在多人 |
| `1girl` | `2girls` | 人数矛盾 |
| `sleeping` / `unconscious` / `closed eyes` | `looking at viewer` | 无意识/闭眼不可能直视 |
| `blindfold` | `heart-shaped pupils` / `rolling eyes` / `looking at viewer` | 看不到眼睛 |
| `expressionless` / `empty eyes` | `smile` / `joyful expression` | 表情矛盾 |

### 16.3 服装互斥

| 标签A | 标签B | 原因 |
|---|---|---|
| `completely nude` | 任何具体服装标签（`dress` `skirt` `armor` 等） | 全裸不穿衣 |
| `pantyhose` | `barefoot` | 穿连裤袜不可能赤脚 |
| `thighhighs` + `barefoot` | — | 穿过膝袜不是赤脚 |
| `blindfold` | `glasses` | 物理冲突 |
| `boots` | `barefoot` | 穿鞋 ≠ 赤脚 |

**例外**：`torn pantyhose` + `barefoot`（脚部撕裂露出）属于合理组合。
**例外**：`off shoulder` + 具体上衣（滑落状态）属于合理组合。

### 16.4 动作互斥

| 标签A | 标签B | 原因 |
|---|---|---|
| `standing` | `lying` / `sitting` / `kneeling` | 姿态三选一 |
| `running` | `standing still` / `sitting` | 运动状态矛盾 |
| `floating` / `flying` | `walking` / `running on ground` | 浮空不能同时地面移动 |
| `closed eyes` | `looking at viewer` | 闭眼不能直视 |
| `sleeping` | `fighting stance` / `action pose` | 睡眠不能战斗 |

### 16.5 细节过度（同一部位多标签冲突）

| 部位 | 矛盾组合 | 原因 |
|---|---|---|
| 脚部 | `high heels` + `barefoot` | 穿与不穿矛盾 |
| 脚部 | `spread toes` + `toe scrunch` | 舒展 vs 蜷缩 |
| 手部 | `clenched fist` + `open hands` / `holding` | 握拳不能张开/握物 |
| 眼睛 | `closed eyes` + `looking at viewer` | 闭眼不能看 |
| 眼睛 | `rolling eyes` + `looking at viewer` | 翻白眼不能直视 |
| 嘴巴 | `open mouth` + `closed mouth` | 开口 vs 闭口 |
| 嘴巴 | `smile` + `clenched teeth` | 笑不能咬紧牙 |
| 腿部 | `spread legs` + `legs together` | 分开 vs 并拢 |
| 腿部 | `crossed legs` + `spread legs` | 交叉 vs 张开 |
| 身体 | `body arching upward` + `curled up` / `fetal position` | 弓背 vs 蜷缩 |
| 头发 | `messy hair` + `neatly styled hair` | 凌乱 vs 整齐 |
| 头发 | `floating hair` + `wet hair clinging to face` | 漂浮 vs 湿贴 |

**原则**：同一部位的状态标签可以多个，但不能互斥。关键在于**状态一致性**而非数量。`barefoot` + `feet focus` + `soles` + `toe scrunch`（四个兼容标签）没问题；`spread toes` + `toe scrunch`（两个互斥标签）矛盾。

---

*基于 anima3 V2 骨架 + AI-KSK 规则 + 所长常规NovalAI个人法典标签库*
*最后更新：2026-05-14*

---

## 17. 实战案例

> 以下为跑图验证过的案例。格式：中文描述 + 完整英文 prompt。
> 拿到好图后手动添加到对应编号下。

### 17.1 （待添加）

### 17.2 （待添加）

### 17.3 （待添加）
