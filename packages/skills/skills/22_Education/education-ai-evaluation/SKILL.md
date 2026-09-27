---
name: education-ai-evaluation
description: 评估教育 AI 助教、反馈和研究辅助工具的教学有效性、准确性、公平性与隐私风险；区分输出质量、用户满意度和真实学习结果。
domain: education-research
aliases: [教育 AI 评估, AI 助教评测, education AI evaluation, AI tutor]
version: 1.0.0
review_status: ai-generated
---

# 教育 AI 评估

## 何时使用

为 AI 助教、自动反馈、作业生成、测评辅助或研究助手制定上线前/试点后评估方案时使用。

## 工作流程

1. 明确学习目标、用户（学生、教师、研究者）、学段、学科、语言、使用环节及人类复核责任。区分系统是否只给建议，还是会影响评分、机会或个体决策。
2. 建立与真实教学任务相符、覆盖难例和不同学习者的评估样本；冻结模型版本、提示、知识来源与评分规则，保留数据划分，避免将测试题用于调参。
3. 分层检查事实与引用可核验性、课程匹配、反馈可操作性、年龄适宜性、无障碍、偏见、隐私泄漏和对错误答案的处理。对开放输出采用盲评与明确评分量规，记录评审分歧和代表性失败例。
4. 与现有教学流程或基线工具比较；若主张提高学习成效，另设计能测量学习结果的研究，记录干预使用、教师工作量与副作用。离线答题准确率和满意度不能单独证明学习收益。
5. 对高风险使用设置人工审阅、纠错/申诉和停止条件；发布后监测版本漂移、群体差异和实际伤害。对学生数据沿用机构审批与数据最小化规则。
6. 参照 [UNESCO 教育生成式 AI 指南](https://www.unesco.org/en/articles/guidance-generative-ai-education-and-research)和 [NIST AI 风险管理框架](https://www.nist.gov/itl/ai-risk-management-framework) 的适用部分，不宣称通过某一框架即可获得教育有效性认证。

## 交付形式

输出评估卡：`用途｜对象｜模型/提示版本｜测试集与来源｜基线｜评分量规｜教学结果｜分群结果｜失败案例｜数据风险｜上线条件和负责人`。外部文档版本与适用范围用 `skill_search(mode="browse", relative_path="22_Education/AUTHORITATIVE_SOURCES.md")` 核对。
