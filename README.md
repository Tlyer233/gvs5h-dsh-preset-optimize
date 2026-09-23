
# 如果你很急,立刻想看27b能不能打过Fable(真实场景打不过,我们有不全的实测 [bilbil](https://www.bilibili.com/video/BV1ashq6zEYV/?spm_id_from=333.337.search-card.all.click&vd_source=a2208fcbd48ebf44fafb42e682e09f82))
- ①复制到`/Users/xi/.dsh/.agent-presets`中 
- ②把config中的`radix`删除这个是配合sglang ctx pool的, sglang的代码我还没发出来
- ③使用`/gvs5h`Command

* 原仓库: https://github.com/slee-persis/GVS5H
* 我们复现: 严格按照其工作流,分数只高1分(可以认为是误差),还在测,还在复现他们的数据集
* 我们发现了什么: 
    - 这玩意可以解决 "本地部署,tps随着pool上下文增长而衰减"的问题
    - 使用这个workflow执行任务质量效果基本不变!!
    - 解决了本地部署的两个问题 ①tps衰减 ②compact时prefill需要时间
    - 前置知识: subagent就是全新的上下文,且是one-shot的,subagent退出后没有任何作用,其上下文留存在sglang的ctx pool中毫无意义; 
    - 我们和sglang配合,在subagent派发时发送sss给到sglang的pool打标记A, 在subagent退出时打标记B,然后把A-B删除,从而实现ctx的pool维持在很小=>tps快(解决衰减问题)

![image_1.png](https://i0.hdslb.com/bfs/new_dyn/76aa0c9799fdf221a048728af9eb12a23706947756886128.png)
* 还在做什么? 
    0. 原gvs5h是one-shot,我们尝试在长上下文(200k)中使用,使其在真实开发中能够使用
    1. 优化编排流程, 下面流程图,我们增加了loop;和替换了原论文的summary_worker,以此解决 qwen3.8 27b雷霆思考的问题(已经做了,且颇有成效)
    2. 我们会对`gvs5h`原仓库的题集进行复测
    3. sglang的池子,在0.5.20中有bug(官方有pr,且已经merge,sglang说会下一个版本一起发布,目前我是修改源码解决的)我们sss和ses清空指令依赖这个,所以你拉下来也得改sglang源码才能复现
    4. vllm, llamacpp的ctx用hash(sglang是🌲),我们也在适配;
* 总结: 27B不可能打过Fable




```
`R:` 读，`W:` 写。WS = `.fable`。U = 计划依赖、但目前说不出的环境事实。
user
        │
        ▼
optimize_manager                       W: 无（组 PROBLEM）
        │
        ▼
[loop 起点 wipeProbe]                  删 try_scripts/ probes.json pressure.json
        │
        ▼
predominant_manager（分诊）            R: history task.md
        │                              W: task.md probes.json（写入 U 列表）
        │
        ├── U 为空 ──────────────────────────────────────────┐
        │                                                   │
        ▼                                                   │
┌─►┌─► predominant_manager            R: probes.json try_scripts/ LAST TRY 或 REPLAN
│  │       │                          W: probes.json（每轮）
│  │       │                             try_scripts/（可选，小验证）
│  │       │                             plan.md tasks.json（仅 READY）
│  │       ▼
│  │   try_worker                     R: TRY 规格 try_scripts/
│  │       │                          W: try_scripts/ 仅此
│  │       │                          host W: pressure.json（soft/firm/hard）
│  └───────┘ STATUS=continue（最多 planRounds 轮）
│          │ STATUS=ready（或 FINAL ROUND 强制 ready）
│          ▼                                                │
│  ┌─► decision_manager  ◄──────────────────────────────────┘
│  │       │                          R: task.md plan.md tasks.json notes.md checks.md deliverable.md
│  │       │                          W: tasks.json
│  │       ▼
│  │   laborer_worker                 R: plan.md notes.md try_scripts/
│  │       │                          W: CWD 交付物 notes.md deliverable.md
│  │       │                             try_scripts/（仅就地修 PLAN 点名的脚本）
│  │       │                          host W: pressure.json（soft/firm/hard）
│  │       ▼
│  │   check_worker                   R: task.md deliverable.md checks.md notes.md pressure.json
│  │       │                          W: checks.md（仅首次）
│  └───────┘ STATUS=continue
│          │
└──────────┘ STATUS=replan（带 REPLAN 证据，最多 replanMax 次；不清 probes.json）
           │
           │ STATUS=done
           ▼
history_worker                         R: 全部 ledger + probes.json + try_scripts/
           │                           W: history；PROMOTE 时复制脚本到 CWD
           ▼
[loop 终点 wipeLedger + wipeProbe]

```