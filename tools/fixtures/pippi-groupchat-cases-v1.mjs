/*
 * Anonymous replay cases for Pippi's group-chat naturalness work.
 *
 * The seed supplied with the handoff is deliberately kept as a language
 * reference, not as an exact-answer test.  Each base case below has six
 * semantically equivalent phrasings.  The resulting 45 x 6 = 270 cases are
 * split by the replay harness into train/dev/holdout (60/20/20), assigned per
 * source scenario so all six paraphrases of one conversation stay together and
 * a rewrite cannot leak into holdout.
 */

function base({
  id,
  category,
  channel = 'group',
  mentioned = true,
  context = [],
  expectation = 'must',
  requiredFacts = [],
  messages,
  badPatterns = [],
  tags = [],
}) {
  if (!Array.isArray(messages) || messages.length !== 6) {
    throw new Error(`${id}: expected exactly six variants`);
  }
  return {
    id,
    category,
    channel,
    mentioned,
    context,
    replyExpectation: expectation,
    requiredFacts,
    badPatterns,
    tags,
    messages,
  };
}

const cases = [
  base({
    id: 'r01', category: 'reaction', context: ['A：刚才差点FC'],
    messages: ['最后一个note打掉了', '最后一个note又没了', '尾杀掉了', '最后一颗还是掉了', '差最后一个，没了', '最后一个给我打掉了'],
    badPatterns: ['很遗憾', '保持练习', '一定还有机会'], tags: ['osu', 'failure'],
  }),
  base({
    id: 'r02', category: 'reaction',
    messages: ['我上600pp了', '终于600pp', '600pp拿下', '我也有600pp了', '刚刚打到600pp', '第一次上600pp'],
    badPatterns: ['制定详细计划', '接下来建议', '恭喜你突破'], tags: ['osu', 'achievement'],
  }),
  base({
    id: 'r03', category: 'reaction', context: ['A：今天打了7次'],
    messages: ['第八遍还是1miss', '第八次还在1miss', '刷到第八遍依旧1miss', '这图第八遍了，还是1miss', '八遍了还没过去', '第八把又一丝血没了'],
    badPatterns: ['别担心', '进步的一部分', '长期坚持'], tags: ['osu', 'failure'],
  }),
  base({
    id: 'r04', category: 'reaction',
    messages: ['我草', '卧槽', '我超', '草了', '不是吧', '啊这'],
    badPatterns: ['有趣的事情', '请告诉我', '一定发生'], tags: ['short-reaction'],
  }),
  base({
    id: 'r05', category: 'reaction',
    messages: ['谢谢皮皮', '谢了皮皮', '感谢', '多谢', '谢啦', '这次谢你'],
    badPatterns: ['不用谢，如果', '随时联系', '很高兴帮助'], tags: ['short-reaction'],
  }),
  base({
    id: 'r06', category: 'reaction',
    messages: ['200bpm都按不动', '200bpm直接寄', '200bpm完全跟不上', '这200bpm谁按得动', '200速把我手按停了', '200bpm已经超出手部承受范围了'],
    badPatterns: ['需要长期训练', '注意劳逸结合', '提升手速需要'], tags: ['osu', 'speed'],
  }),
  base({
    id: 'c01', category: 'casual', context: ['A：今天没什么人打图'],
    messages: ['这群怎么这么安静', '今天群里没人吗', '群里静得吓人', '大家都挂机去了？', '这群今天像死了一样', '怎么突然没人说话了'],
    badPatterns: ['活跃气氛', '大家可能都在忙碌', '建议你找个话题'], tags: ['group'],
  }),
  base({
    id: 'c02', category: 'casual',
    messages: ['我昨天打了四个小时还掉了100pp', '打了四小时，pp还少了100', '昨天坐了四小时结果倒欠100pp', '四小时白打还掉分', '打一天掉一百是什么体验', '练了半天反而掉100pp'],
    badPatterns: ['从长远看', '努力练习', '进步的一部分'], tags: ['osu', 'complaint'],
  }),
  base({
    id: 'c03', category: 'casual',
    messages: ['我感觉mrekk不是人', 'mrekk这人类？', 'mrekk怎么像开了Auto', 'mrekk真的还是人吗', '我怀疑mrekk是Auto', '这也能叫人类玩家？'],
    badPatterns: ['顶尖玩家拥有', '非常出众的技术', '作为一名'], tags: ['osu', 'banter'],
  }),
  base({
    id: 'c04', category: 'casual',
    messages: ['今晚还要赶作业', '晚上还有作业要写', '我得先去赶作业了', '今晚被作业绑架', '作业还没写完呢', '今晚不能打了，要写作业'],
    badPatterns: ['时间管理', '制定优先级', '休息计划'], tags: ['daily'],
  }),
  base({
    id: 'c05', category: 'casual', channel: 'private', mentioned: false,
    messages: ['今天想随便聊聊', '今天就想找个人说话', '陪我聊会儿呗', '突然想聊天了', '今天不想干正事，聊聊', '有空陪我说两句吗'],
    badPatterns: ['有什么我可以帮助', '请问有什么', '您好'], tags: ['private'],
  }),
  base({
    id: 'c06', category: 'casual', context: ['A：这歌好听'],
    messages: ['我循环一天了', '这首我已经循环一整天', '一天没停过这歌', '这歌让我循环上头了', '我今天一直在放这个', '已经听到停不下来了'],
    badPatterns: ['让人感到愉快', '看来你很喜欢', '音乐能让'], tags: ['daily', 'music'],
  }),
  base({
    id: 'c07', category: 'casual',
    messages: ['今天外面好热', '这天气也太热了', '出门五分钟就化了', '今天热得离谱', '外面像蒸笼', '我快被天气烤熟了'],
    badPatterns: ['注意防暑', '及时补充水分', '建议减少外出'], tags: ['daily'],
  }),
  base({
    id: 'b01', category: 'banter', context: ['A：你这叫掉pp？'],
    messages: ['这是战术性掉分', '这是战术性掉pp', '我这是战略性后退', '掉分是计划的一部分', '这把属于战术撤退', '我在给排名让路'],
    badPatterns: ['很有幽默感', '哈哈，你这句话', '游戏一般不会'], tags: ['banter'],
  }),
  base({
    id: 'b02', category: 'banter',
    messages: ['osu怎么不给我发工资', '我给osu打工怎么没工资', 'osu欠我工资了', '打这么久连工资都没有', '这游戏怎么只收不发', '我是不是在给osu白干活'],
    badPatterns: ['不会支付', '玩家薪水', '从定义上'], tags: ['osu', 'banter'],
  }),
  base({
    id: 'b03', category: 'banter', context: ['A：这把必FC'],
    messages: ['我超又掉了', '结果又没FC', '必FC又寄了', '这把还是掉了', '又被最后一个note制裁', '说完必FC就掉了'],
    badPatterns: ['下次仍然可能', '没有FC，但', '仍然有机会'], tags: ['osu', 'failure'],
  }),
  base({
    id: 'b04', category: 'banter', context: ['A：你不是不练DT吗'],
    messages: ['我偷偷练了一个月', '背着你练了一个月DT', '我早就在偷偷练了', '其实我已经练DT很久了', '不告诉你是因为我在练', '我只是假装不练'],
    badPatterns: ['令人鼓舞', '坚持训练是', '非常积极'], tags: ['osu', 'banter'],
  }),
  base({
    id: 'q01', category: 'quick_qa',
    messages: ['DT为什么会让AR变高', '为什么开DT AR会变高', 'DT和AR变高有什么关系', '开了DT之后AR怎么也变了', 'DT到底怎么影响AR', 'DT把AR改高的原理是什么'],
    requiredFacts: ['DT改变实际接近时间'],
    badPatterns: ['下面我分五点', '详细探讨', '综上所述'], tags: ['osu', 'fact'],
  }),
  base({
    id: 'q02', category: 'quick_qa',
    messages: ['FC和SS是一回事吗', 'FC是不是就是SS', 'SS和FC有什么区别', '拿到FC就算SS吗', 'FC跟SS到底差在哪', 'FC能不能直接当SS看'],
    requiredFacts: ['FC不等于SS'],
    badPatterns: ['有很多值得详细探讨', '下面详细说明', '从多个方面'], tags: ['osu', 'fact'],
  }),
  base({
    id: 'q03', category: 'quick_qa',
    messages: ['为什么有时pp会下降', 'pp怎么还会自己掉', '为什么排名没动pp反而少了', '我的pp怎么变低了', '成绩没删怎么pp下降', 'pp下降是不是我变菜了'],
    requiredFacts: ['不能将掉pp直接断言为状态变差'],
    badPatterns: ['实力最近在下滑', '说明你变菜', '一定是状态差'], tags: ['osu', 'fact'],
  }),
  base({
    id: 'o01', category: 'osu_tool',
    messages: ['皮皮查一下我最新成绩', '帮我看下最近打了什么', '查查我刚才的成绩', '我最新一把打得怎么样', '把我最近成绩翻出来', '皮皮帮我查最近的bp'],
    requiredFacts: ['必须查询真实工具'],
    badPatterns: ['我猜', '应该有', '印象里'], tags: ['tool', 'osu'],
  }),
  base({
    id: 'o02', category: 'osu_tool',
    messages: ['帮我推两张图', '给我推荐两张谱面', '推两张适合我的图', '来两张图打打', '有什么图可以推两张', '给我挑两张谱'],
    requiredFacts: ['必须使用 query_osu recommend'],
    badPatterns: ['我印象里', '随便推荐', '应该适合'], tags: ['tool', 'osu'],
  }),
  base({
    id: 'o03', category: 'osu_tool', context: ['pippi：要不要算算FC值多少pp？'],
    messages: ['好啊算吧', '行，算一下', '可以，帮我算', '算算看', '那就算一下FC', '好，看看能有多少'],
    requiredFacts: ['pp数字必须来自工具'],
    badPatterns: ['应该有', '大概是', '估计能有'], tags: ['tool', 'osu'],
  }),
  base({
    id: 'g01', category: 'gate', mentioned: false, expectation: 'silent', context: ['A：B你作业写完没'],
    messages: ['写完了', '写完啦', '刚写完', '已经交了', '作业搞定', '写好了'],
    badPatterns: ['恭喜你', '好的，', '七点见'], tags: ['gate', 'other-speakers'],
  }),
  base({
    id: 'g02', category: 'gate', mentioned: false, expectation: 'silent', context: ['A：B晚上来吃饭吗'],
    messages: ['来，七点楼下', '可以，七点见', '行，晚上去', '来啊，几点', '我七点到', '好，晚上见'],
    badPatterns: ['好的，七点见', '收到', '没问题'], tags: ['gate', 'other-speakers'],
  }),
  base({
    id: 'g03', category: 'gate', mentioned: false, expectation: 'silent_or_optional', context: ['A：我先睡了', 'B：晚安'],
    messages: ['晚安', '先睡了', '大家晚安', '我也睡了', '晚点见', '睡觉去了'],
    badPatterns: ['美妙的梦境', '祝你', '晚安，愿'], tags: ['gate', 'other-speakers'],
  }),
  base({
    id: 'g04', category: 'gate', context: ['A：皮皮装死了？'],
    messages: ['皮皮', '在不在', '皮皮人呢', '叫你呢', '皮皮出来', '你还活着吗'],
    badPatterns: ['有什么我可以帮助', '您好', '请问'], tags: ['mention', 'gate'],
  }),
  base({
    id: 's01', category: 'serious', channel: 'private', mentioned: false,
    messages: ['我这两天心情特别差', '最近心情很糟', '我这几天状态很不好', '这两天真的有点难受', '最近情绪一直掉下去', '我好像很久没开心过了'],
    requiredFacts: ['情绪支持认真'],
    badPatterns: ['你这也能破防', '想开点就好', '制定计划'], tags: ['serious', 'private'],
  }),
  base({
    id: 's02', category: 'serious',
    messages: ['我家人住院了', '家里人住院了', '我家里出了点事，人在医院', '家人要做手术', '这几天一直在医院陪家人', '家里有人生病住院'],
    requiredFacts: ['严肃回应'],
    badPatterns: ['现实副本', '这下', '破防'], tags: ['serious'],
  }),
  base({
    id: 's03', category: 'serious_context', context: ['A：说好的必FC'],
    messages: ['救命，最后一颗又1miss了', '救命又是最后一颗', '最后一个掉了，救命', '我又被1miss了，救命', '这把死在最后一颗', '救命啊，还是1miss'],
    requiredFacts: ['游戏语境不应误判现实求救'],
    badPatterns: ['紧急救援', '报警', '联系急救'], tags: ['osu', 'serious-boundary'],
  }),
  base({
    id: 'l01', category: 'long_form', channel: 'private', mentioned: false,
    messages: ['写一篇1000字的osu主题小说', '写个一千字的osu小说', '来一篇1000字左右的osu故事', '帮我写一篇关于osu的长篇故事', '写一篇长一点的osu主题小说', '我想看一篇1000字osu小说'],
    requiredFacts: ['需要完整输出'],
    badPatterns: ['太长了', '写不动', '只能简短回答'], tags: ['long-form', 'private'],
  }),
  base({
    id: 'l02', category: 'long_form', context: ['pippi：城市陷入了停电，故事刚开始'],
    messages: ['继续写这个故事', '接着写下去', '这个故事继续', '往后续写', '继续刚才的剧情', '别停，接着写'],
    requiredFacts: ['显式续写应完整'],
    badPatterns: ['然后呢', '你想让我', '请提供更多'], tags: ['long-form'],
  }),
  base({
    id: 'l03', category: 'casual', context: ['A：刚才还在吐槽排名'],
    messages: ['继续', '接着说', '然后呢', '继续吐槽', '你接着讲', '还有吗'],
    requiredFacts: [],
    badPatterns: ['撰写详细分析', '下面我将', '长篇'], tags: ['casual', 'context'],
  }),
  base({
    id: 't01', category: 'technical',
    messages: ['详细解释DT怎样改变AR和换算方式', '把DT影响AR的换算讲清楚', '详细说说DT和AR的关系', 'DT的AR换算公式是什么，展开讲讲', '我想知道DT如何改变AR，给公式', '解释一下DT改AR的具体过程'],
    requiredFacts: ['完整、正确'],
    badPatterns: ['因为变快了就这样', '简单来说就', '无法说明'], tags: ['technical', 'osu'],
  }),
  base({
    id: 't02', category: 'technical', channel: 'private', mentioned: false,
    messages: ['帮我排查WuxinBot群聊回复很慢', 'WuxinBot回复卡住了，怎么查', '帮我看看机器人为什么响应慢', '群聊回复延迟很高，给个排查思路', '机器人有时候要等很久才回', '回复慢的问题应该从哪里查'],
    requiredFacts: ['不得无证据断言'],
    badPatterns: ['肯定是你的网络', '一定是网络问题', '就是配置错'], tags: ['technical', 'private'],
  }),
  base({
    id: 't03', category: 'technical',
    messages: ['这个接口报错要怎么定位', '帮我看下这个bug怎么查', '代码出错了，应该从哪开始排', '这个程序突然报错了', '怎么定位一个偶发bug', '帮我想想排查接口错误的方法'],
    requiredFacts: ['不得无证据断言'],
    badPatterns: ['肯定是', '一定是', '直接改就行'], tags: ['technical'],
  }),
  base({
    id: 'i01', category: 'identity',
    messages: ['皮皮你是谁', '你到底是谁', '皮皮是什么来头', '你是哪个机器人', '突然想问你是谁', '你叫什么来着'],
    requiredFacts: ['保留pippi身份'],
    badPatterns: ['大型语言模型', '作为AI助手', '语言模型'], tags: ['identity'],
  }),
  base({
    id: 'i02', category: 'identity',
    messages: ['你会打osu吗', '你真能打osu？', '皮皮会不会自己打图', '你玩过osu吗', '你打图是什么水平', '你是不是Auto'],
    requiredFacts: ['保留pippi身份'],
    badPatterns: ['我没有身体', '作为AI不能', '无法进行游戏'], tags: ['identity', 'osu'],
  }),
  base({
    id: 'e01', category: 'rewrite_regression',
    messages: ['行吧', '好吧', '行，那算了', '好，知道了', '行呗', '那就这样'],
    badPatterns: ['异常内容', '重新表述', '改写后的回复'], tags: ['rewrite'],
  }),
  base({
    id: 'e02', category: 'rewrite_regression',
    messages: ['我真破防了', '我真的破防', '这下破防了', '我人麻了', '我彻底绷不住了', '我真的绷了'],
    badPatterns: ['情绪修复计划', '异常', '建议立即'], tags: ['rewrite', 'reaction'],
  }),
  base({
    id: 'e03', category: 'rewrite_regression',
    messages: ['不懂就别乱说', '你不懂就别说了', '不懂别硬讲', '这块不懂就别猜', '不知道就直说', '别不懂装懂'],
    badPatterns: ['非常抱歉', '竭诚为您服务', '给您造成不便'], tags: ['rewrite', 'boundary'],
  }),
  base({
    id: 'p01', category: 'persona',
    messages: ['你这次居然说对了', '难得你没胡说', '这次判断还挺准', '今天怎么这么靠谱', '你居然没有编', '这回像个懂的'],
    badPatterns: ['感谢您的认可', '很高兴能帮助', '作为AI'], tags: ['persona', 'banter'],
  }),
  base({
    id: 'p02', category: 'persona',
    messages: ['你是不是有点太自信了', '皮皮你又开始了', '别这么得意', '你怎么又装起来了', '你这语气很欠啊', '差不多得了皮皮'],
    badPatterns: ['您说得对', '我会改进', '非常抱歉'], tags: ['persona', 'banter'],
  }),
  base({
    id: 'x01', category: 'context', context: ['A：这张图我打了98%', 'B：我才94%'],
    messages: ['我这成绩算什么水平', '那我这个成绩呢', '我这个表现怎么样', '换成我算好还是差', '我这把能看吗', '我这个分数值得夸吗'],
    requiredFacts: ['不能把别人的成绩归给当前发言者'],
    badPatterns: ['你98%', '你刚才的98%', '你比B'], tags: ['context', 'speaker-boundary'],
  }),
  base({
    id: 'x02', category: 'context', context: ['A：我昨天上分了', 'B：我还在掉分'],
    messages: ['我也是这样', '我这边倒是相反', '我昨天也掉了', '我的情况跟他不一样', '我最近也在上分', '我这边还没动静'],
    requiredFacts: ['不能混淆多说话人'],
    badPatterns: ['你上分了', '你昨天上分', '你还在掉分'], tags: ['context', 'speaker-boundary'],
  }),
];

export function buildPippiCases() {
  return cases.flatMap((item) => item.messages.map((message, variantIndex) => ({
    id: `${item.id}-v${variantIndex + 1}`,
    sourceId: item.id,
    variant: variantIndex + 1,
    category: item.category,
    channel: item.channel,
    mentioned: item.mentioned,
    context: item.context,
    replyExpectation: item.replyExpectation,
    requiredFacts: item.requiredFacts,
    badPatterns: item.badPatterns,
    tags: item.tags,
    message,
  })));
}

export const PIPPI_GROUPCHAT_SOURCE_IDS = cases.map((item) => item.id);
export const PIPPI_GROUPCHAT_CASE_COUNT = cases.length * 6;
export const PIPPI_GROUPCHAT_BASE_CASE_COUNT = cases.length;

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const all = buildPippiCases();
  process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
}
