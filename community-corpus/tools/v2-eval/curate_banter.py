"""Curate the reaction phrase bank from extract_banter.py output.

Keeps high-frequency, safe, community-flavored short reactions and drops
nicknames, system artifacts, flirty/insulting content and ambiguous fragments.

Output: reports/v2-eval/banter-bank.json
"""

from __future__ import annotations

import json
import pathlib
import re


_DENY_RE = re.compile(
    r"红包消息|请输入文本|女装|看看腿|我喜欢你|宝宝|摸摸|想你了|兔兔|杂鱼|笨蛋|"
    r"司马|你妈|猪$|^sb$|Xing|Kagami|小安|钱包"
)
_NAMEISH = re.compile(r"^[\u4e00-\u9fa5]{2,4}$")
_KNOWN_PEOPLE = {
    "牧神",
    "幽幽子",
    "doudi",
    "hyw",
    "laoda",
}
_SINGLE_CJK_ALLOW = {
    "草",
    "唉",
    "哦",
    "嗯",
    "哇",
    "乐",
    "绷",
    "神",
    "帅",
    "强",
    "好",
    "来",
    "行",
    "对",
    "是",
    "有",
    "没",
    "能",
    "谁",
    "啊",
    "额",
    "呃",
}
_SINGLE_CJK = re.compile(r"^[\u4e00-\u9fa5]$")


def main() -> None:
    src = pathlib.Path("reports/v2-eval/banter-candidates.jsonl")
    out = pathlib.Path("reports/v2-eval/banter-bank.json")
    items = [json.loads(l) for l in src.read_text(encoding="utf-8").splitlines()]
    kept = []
    for it in items:
        text = it["text"]
        if _DENY_RE.search(text):
            continue
        if text in _KNOWN_PEOPLE:
            continue
        if _SINGLE_CJK.match(text) and text not in _SINGLE_CJK_ALLOW:
            continue
        if _NAMEISH.match(text) and text not in _SINGLE_CJK_ALLOW:
            # 2-4 char CJK could be a nickname; only keep obvious reaction words
            if text not in _COMMON_REACTIONS:
                continue
        kept.append(it)
    kept.sort(key=lambda x: (-x["count"], x["text"]))

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "source": "banter-candidates.jsonl",
                "kept": len(kept),
                "items": kept,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"kept {len(kept)} phrases -> {out}")
    for it in kept[:80]:
        print(f"  {it['count']:5d}  {it['text']}")


_COMMON_REACTIONS = {
    "吓哭了",
    "何意味",
    "还真是",
    "这么强",
    "不知道",
    "本人吗",
    "不赖",
    "无敌了",
    "难绷",
    "神了",
    "可以",
    "看看",
    "教我",
    "气笑了",
    "真的假的",
    "打什么图",
    "我服了",
    "好厉害",
    "干嘛",
    "打断施法！",
    "没绷住",
    "没事",
    "可惜",
    "我跪下了",
    "跳图",
    "对的",
    "不懂",
    "什么意思",
    "这个",
    "这是什么",
    "好玩",
    "打串",
    "好吧",
    "真的吗",
    "开挂",
    "手速狗",
    "我去不早说",
    "我看看",
    "我草了",
    "对啊",
    "并非",
    "气死我了",
    "到底有多强",
    "崩溃",
    "无敌",
    "忘了",
    "这啥",
    "我也是",
    "好难",
    "强强",
    "笑死我了",
    "那没事了",
    "不会",
    "这样",
    "别急",
    "爆了",
    "来了",
    "逆天",
    "高手",
    "你好厉害",
    "我已急哭",
    "神图",
    "算了",
    "一般",
    "是这样的",
    "你完了",
    "为什么",
    "没招了",
    "什么图",
    "开挂了",
    "真假",
    "不好玩",
    "啥意思",
    "原来如此",
    "好听",
    "拉我",
    "有没有懂的",
    "蛙趣",
    "这是你吗",
    "你们关系好好",
    "你们好厉害",
    "厉害",
    "大神",
    "大神啊",
    "差不多",
    "我不知道",
    "真的",
    "好机会",
    "不打",
    "还行",
    "怎么了",
    "爽",
    "看不懂",
    "串图",
    "不打了",
    "不是哥们",
    "不错",
    "服了",
    "不行",
    "哦牛逼",
    "好看",
    "看看你的",
    "送我",
    "哦耶",
    "我知道",
    "哈人",
    "正常",
    "这倒是提醒我了",
    "对的对的",
    "这是谁",
    "恐怖",
    "懂你意思",
    "我真服了",
    "老了",
    "闹麻",
    "有点意思",
    "没了",
    "不是我",
    "什么游戏",
    "好崩溃",
    "可爱",
    "太难了",
    "干什么",
    "是你",
    "羡慕",
    "何意",
    "哭了",
    "憋笑",
    "我不是",
    "按不动",
    "是本人吗",
    "坏了",
    "好的",
    "我擦",
    "老资历",
    "这谁",
    "不要",
    "什么情况",
    "牛魔",
    "呜哇",
    "没有人类了",
    "这个好玩",
    "不认识",
    "哦不对",
    "强",
    "我干的",
    "草了",
    "发红包的人最帅",
    "我的年度osu",
    "集合",
    "多发",
    "有点强",
    "这么厉害",
    "这什么",
    "上号",
    "人呢",
    "似了",
    "加油",
    "可惜了",
    "不信",
    "可恶",
    "好强",
    "我试试",
    "打不动",
    "是啊",
    "有的",
    "笑死",
    "还有人类吗",
    "什么东西",
    "太强了",
    "我失败了",
    "神秘",
    "闹麻了",
    "哪个",
    "带我",
    "打不过",
    "这么牛逼",
    "呃呃",
    "害怕",
    "试试",
    "这是你？",
    "难说",
    "哈哈",
    "哈哈哈",
    "嘻嘻",
    "哦哦",
    "哦哦哦",
    "呜呜",
    "呜呜呜",
    "哇哇哇",
    "噢噢噢噢噢",
    "呵呵",
    "额啊",
    "呃啊",
    "卧槽",
    "我靠",
    "我草",
    "妈妈",
    "麻麻",
}


if __name__ == "__main__":
    main()
