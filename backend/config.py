"""
配置管理 · 集中一处

所有可调项（密钥、超时、图片限制、风格提示词）都在这里，改配置只改这一处。
.env 相对本文件位置解析，不依赖启动时的工作目录。
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# ---------- 图片限制（需求：不设限，但要有内存兜底） ----------
MAX_BYTES = 40 * 1024 * 1024      # 单张图片 40MB
MAX_PIXELS = 50_000_000           # 解码后像素总数上限，防内存炸弹

# ---------- 阿里云百炼 · 千问-图像生成与编辑 3.0 ----------
ALIYUN_API_KEY = os.getenv("ALIYUN_API_KEY", "")
ALIYUN_BASE_URL = os.getenv("ALIYUN_BASE_URL", "").rstrip("/")
ALIYUN_MODEL = os.getenv("ALIYUN_MODEL", "qwen-image-3.0")

STYLE_TIMEOUT = 60                # 单次风格化生成上限（需求 §3 假设 8：≤ 60 秒）
API_TIMEOUT = 30                  # 单次 HTTP（生成请求之外的下载等）上限

# ---------- 提示词智能改写开关 ----------
# 实测（test/222.png，各 3-4 次）：
#   prompt_extend=true  → 单次 17-41 秒，且改写会放大提示词里的歧义（见下）
#   prompt_extend=false → 单次 6-7 秒，姿势保真度不降反升（3/3 忠实还原输入姿势）
# 我们的提示词本身就是长描述（不是「一句话提示词」），改写收益很小，
# 因此关闭以求「快 + 可预测」——少一个不受控的改写环节，行为更稳定。
STYLE_PROMPT_EXTEND = False

# ---------- 风格提示词（对用户不可见，需求 Story 8.1） ----------
# ⚠️ 同步链：本字典的 key 必须与 拼豆转换器.html 中风格按钮的 data-s 属性保持一致。
#    改风格列表时两处同改，改完跑 test-p2.cjs 的「风格 key 同步链」用例。
#
# ★ 提示词红线（2026-09 实测踩坑）：**不要出现「表情包」这类多格暗示词**。
#   原始提示词写的是「chibi 画风表情包」，模型把它理解成「一整版多格表情贴纸包」，
#    实测 4 次里有 1 次直接吐出 3×3 九宫格（9 个姿势拼一张图）；
#    同理「互不遮挡」也在暗示「存在多个主体」。改为「整幅画面只画一个主体 / 单一完整画面」
#    并配 STYLE_NEGATIVE_PROMPTS 之后，7 次采样全部单主体。
STYLE_PROMPTS = {
    # 已开放：扁平插画风（用户在原始提示词基础上做的**最小必要修订**：
    # 删「表情包」「互不遮挡」，加「只画一个主体 / 单一完整画面 / 保持输入姿势」）
    "flat": (
        "将这张图片转换为 chibi 画风的像素角色插画：整幅画面只画一个主体，"
        "与输入图中的对象一致，保持输入图中主体（人物或动物）的姿势与动作；"
        "单一完整画面，主体居中、完整不被裁切，纯白背景。"
        "Q 版比例，简化的卡通面部特征（清晰的眼睛、鼻子、嘴巴），清晰的像素线条，"
        "最多 6-8 种明亮纯色，每个像素区域只含一种纯色，不混色，"
        "边缘干净、颜色完美分离。"
    ),
    # 占位：尚未开放（前端置灰「即将上线」，服务端也会拒收）
    "pixel": "将图片转换为像素艺术风格，保留主要特征和颜色，使用有限的调色板，清晰的像素边缘。",
    "oil": "将图片转换为油画风格，使用厚涂笔触和丰富的色彩层次，保留主体特征。",
    "water": "将图片转换为水彩画风格，使用淡彩晕染和柔和的过渡，保留主体特征。",
}

# 负向提示词：把「多主体 / 多格拼贴」这条路堵死（提示词再严谨，模型仍可能随机跑偏）
STYLE_NEGATIVE_PROMPTS = {
    "flat": (
        "多格，四宫格，九宫格，拼图，拼贴，分镜，贴纸合集，表情包合集，"
        "多个角色，重复角色，多个姿势，多个人物，文字，水印"
    ),
}
# 未单独配置的风格用的通用负向词
STYLE_NEGATIVE_DEFAULT = "多个角色，重复角色，拼图，拼贴，文字，水印"

# 已开放的风格（可点击、服务端接受）。未列出的风格一律拒收。
# ⚠️ 同步链：必须等于 HTML 中「未 disabled」的风格按钮 data-s 集合。
STYLE_ENABLED = ("flat",)


def get_style_prompt(style_key: str) -> str:
    """取风格提示词；未知 key 回退到已开放的第一个风格。"""
    return STYLE_PROMPTS.get(style_key) or STYLE_PROMPTS[STYLE_ENABLED[0]]


def get_style_negative(style_key: str) -> str:
    """取负向提示词；未配置的风格回退到通用负向词。"""
    return STYLE_NEGATIVE_PROMPTS.get(style_key) or STYLE_NEGATIVE_DEFAULT


def is_style_enabled(style_key: str) -> bool:
    return style_key in STYLE_ENABLED


def style_transfer_ready() -> bool:
    """风格化生成是否可用（密钥已配置）。"""
    return bool(ALIYUN_API_KEY and ALIYUN_BASE_URL)
