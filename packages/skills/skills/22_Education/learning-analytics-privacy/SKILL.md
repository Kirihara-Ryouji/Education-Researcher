---
name: learning-analytics-privacy
description: 审查学习平台日志和学生数据分析的粒度、泄漏、偏差及隐私授权；用于学习分析与预测评估，不将点击量等同于学习或成绩因果效应。
domain: education-research
aliases: [学习分析, 学生数据隐私, learning analytics, student data privacy]
version: 1.0.0
review_status: ai-generated
---

# 学习分析与学生数据保护

## 何时使用

分析作业、测验、出勤、LMS 事件或教育应用日志，构建参与度指标或预测风险时使用。使用个体层数据前先确认机构授权和适用法律；本技能不授予数据访问权。

## 工作流程

1. 明确用途与决策对象：描述班级模式、反馈教学还是预测个体支持需求。记录学生、班级、课程和时间的粒度及连接键，识别重复事件、缺失、时区和系统变更。
2. 建立事件定义与观察窗口；区分未登录、未采集和缺席。点击、在线时长和提交次数是行为代理指标，不直接证明知识掌握或动机。
3. 在预测任务中锁定结果出现前可用的特征，按部署场景做学生/班级/学校/时间分割，防止同一学习者或未来信息泄漏。报告基线模型、误差、校准及群体差异；不把相关/预测称为干预因果效应。
4. 只收集完成目的所需的数据，制定角色访问、保留/删除、脱敏和输出抑制方案；小群体汇总仍可能被重识别。把原始学生记录送至外部服务前，核对机构批准、合同和数据处理条件。
5. 美国教育记录可参考[美国教育部学生隐私资源](https://studentprivacy.ed.gov/privacy-and-education-technology)与[FERPA 研究例外说明](https://studentprivacy.ed.gov/faq/may-educational-agency-or-institution-disclose-personally-identifiable-information-students)；其他地区按当地法律和机构规则办理，不把美国例外外推。隐私风险治理可参考 [NIST 隐私框架](https://www.nist.gov/privacy-framework)。

## 交付形式

输出数据字典、授权/用途记录、指标定义、质量与泄漏检查、分群结果、行动与潜在伤害、保留/删除计划。若授权不明，先用合成或去标识示例设计分析，不接触可识别原始数据。来源索引用 `skill_search(mode="browse", relative_path="22_Education/AUTHORITATIVE_SOURCES.md")` 读取。
