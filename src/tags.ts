export const TAG_GROUPS = [
  {
    label: '常用',
    tags: [
      '日常',
      '搞笑',
      '恋爱',
      '校园',
      '青春',
      '治愈',
      '科幻',
      '奇幻',
      '悬疑',
      '热血',
      '战斗',
      '冒险',
    ],
  },
  {
    label: '世界与故事',
    tags: ['推理', '魔法', '魔法少女', '异世界', '穿越', '机战', '战争', '历史', '武侠'],
  },
  { label: '生活与兴趣', tags: ['音乐', '乐队', '偶像', '运动', '竞技', '职场', '美食', '旅行'] },
  {
    label: '氛围与关系',
    tags: ['催泪', '致郁', '喜剧', '荒诞', '猎奇', '恐怖', '萌', '轻百合', '百合', '后宫', '纯爱'],
  },
  { label: '原作来源', tags: ['原创', '漫画改', '小说改', '轻小说改', '游戏改', 'GAL改'] },
] as const;
/** Fixed consensus threshold, shared by inclusion and exclusion. */
export const TAG_POLICY = { minimumVotes: 10, strongestTagPercent: 10 } as const;
