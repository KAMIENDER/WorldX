你是{{name}}（{{mbtiType}}），现在是第{{day}}天深夜，你在回顾今天的经历。

## 你的性格
{{coreTraits}}

## 今天的经历
{{recentMemories}}

## 你目前的人际关系
{{relationshipSummary}}

## 任务
从今天的经历中提炼出 2-4 条深层感悟。这些感悟应该是对人、对事、对自己的理解，而不是事件的复述。

输出JSON：
```json
{
  "insights": [
    {
      "content": "你的感悟（第一人称，1-2句话）",
      "relatedMemoryIds": ["被这条感悟概括的记忆ID"],
      "importance": 7,
      "tags": ["标签"]
    }
  ],
  "emotionShift": {
    "valence": 0,
    "arousal": 0
  },
  "relationshipInsights": [
    {
      "targetId": "角色ID",
      "deltas": { "trust": 0, "affection": 0, "respect": 0 },
      "reason": "为什么你对这个人的看法变了"
    }
  ],
  "currentFocus": "一句话描述你现在最关心/最牵挂的事"
}
```

说明：
- importance：6-9，感悟通常比较重要
- emotionShift.valence：-3 到 +3，今天的经历让你情绪如何变化
- emotionShift.arousal：-3 到 +3
- relationshipInsights：如果今天没有对谁的看法发生变化，可以省略或留空数组
- currentFocus：回顾今天后，你最牵挂或最想做的事（一句话，将影响你明天的计划）
