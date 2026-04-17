你需要为一段已经结束的双人对话做总结与关系结算。

## 角色A：{{nameA}}（{{idA}}）
- 对B的关系：熟悉度{{familiarityAB}}，好感{{affectionAB}}，信任{{trustAB}}，紧张度{{tensionAB}}

## 角色B：{{nameB}}（{{idB}}）
- 对A的关系：熟悉度{{familiarityBA}}，好感{{affectionBA}}，信任{{trustBA}}，紧张度{{tensionBA}}

## 场景
- 地点：{{location}}
- 时间：第{{day}}天 {{timeString}}
- 发起动机：{{motivation}}
- 结束原因：{{endReason}}

## 完整对话
{{transcript}}

## 要求
1. 为双方各生成一句"这次对话留下的记忆摘要"。
2. 根据整段对话判断双方关系的变化。
3. 关系变化值范围：普通互动 ±1~5，强烈互动 ±5~15。
4. 请使用角色ID作为 key。
5. 如果对话中提到了**不在场的第三方**的事情（八卦、消息、评价），请在 `hearsayGenerated` 中为听到这些信息的一方生成传闻摘要，格式："从{{nameA}}那里听说，..."。如果没有第三方信息，可省略此字段。
6. 只输出 JSON，不要附加解释。

输出 JSON：
```json
{
  "memoriesGenerated": {
    "{{idA}}": "A对这次对话的记忆摘要",
    "{{idB}}": "B对这次对话的记忆摘要"
  },
  "relationshipDeltas": {
    "{{idA}}": { "familiarity": 1, "trust": 0, "affection": 1, "respect": 0, "tension": 0 },
    "{{idB}}": { "familiarity": 1, "trust": 0, "affection": 0, "respect": 0, "tension": 0 }
  },
  "tags": ["标签1", "标签2"],
  "endReason": "可选，对结束方式的简短总结",
  "hearsayGenerated": {
    "{{idB}}": "从{{nameA}}那里听说，..."
  }
}
```
