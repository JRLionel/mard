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
# ⚠️ 同步链：内置风格的 key 必须与 拼豆转换器.html 中对应按钮的 data-s 属性一致；
#    唯一的例外是 `custom`（自定义）——它不在本字典里，提示词由用户在弹窗里输入后随请求发送。
#    改风格列表时三处同改（HTML 的 data-s / 本字典 / STYLE_ENABLED），改完跑 test-p2.cjs。
#
# ★ 提示词红线（2026-09 实测踩坑）：**不要出现「表情包」这类多格暗示词**。
#   原始提示词写的是「chibi 画风表情包」，模型把它理解成「一整版多格表情贴纸包」，
#    实测 4 次里有 1 次直接吐出 3×3 九宫格（9 个姿势拼一张图）；
#    同理「互不遮挡」也在暗示「存在多个主体」。改为「整幅画面只画一个主体 / 单一完整画面」
#    并配 STYLE_NEGATIVE_PROMPTS 之后，7 次采样全部单主体。
#   → pixel / bead 采用用户指定文案，本身不含多格词，仍统一挂 STYLE_NEGATIVE_PROMPTS 兜底。
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
    # 已开放：像素风（用户指定文案，2026-09）
    "pixel": (
        "像素画，可爱 Q 版主体，低分辨率像素颗粒，柔和干净配色，平涂色块，无复杂阴影，"
        "圆润软萌轮廓，简约大眼睛，治愈可爱表情，浅米纯色背景，2D 卡通像素动画，"
        "轻微呼吸晃动动画效果，画面稳定，流畅微动，无大幅度动作，复古像素风格，暖色调，"
        "干净画面，细节简单，童趣，8bit 像素，拼豆风格，线条柔和，高清。"
    ),
    # 已开放：拼豆卡通风（用户指定文案，2026-09：星露谷 / 16 位像素风，为「转图纸」优化）
    "bead": (
        "参考图中提取主体，移除背景并替换为纯白色。像素艺术风格，16 位游戏风格，"
        "星露谷物语风格，16×16 像素，清晰的像素线条，Q 版像素角色，"
        "简化的卡通面部特征（清晰的眼睛、鼻子、嘴巴），量化为最多 6 至 8 种明亮纯色，"
        "每个像素区域仅包括一种纯色，不混色，严格的单色规则，白色背景，完美的颜色分离。"
    ),
}

# 负向提示词：把「多主体 / 多格拼贴」这条路堵死（提示词再严谨，模型仍可能随机跑偏）
STYLE_NEGATIVE_PROMPTS = {
    "flat": (
        "多格，四宫格，九宫格，拼图，拼贴，分镜，贴纸合集，表情包合集，"
        "多个角色，重复角色，多个姿势，多个人物，文字，水印"
    ),
    # bead 额外拦「珠子 / 颗粒 / 写实 / 渐变阴影」：转图纸要求少色、无渐变，
    # 防止模型把「像素平涂」画成珠子质感或照片质感（重采样后会产生脏色）
    "bead": (
        "多格，四宫格，九宫格，拼图，拼贴，分镜，贴纸合集，表情包合集，"
        "多个角色，重复角色，多个姿势，多个人物，文字，水印，"
        "渐变，阴影，写实，照片，珠子，颗粒"
    ),
}
# 未单独配置的风格用的通用负向词
STYLE_NEGATIVE_DEFAULT = "多个角色，重复角色，拼图，拼贴，文字，水印"

# 已开放的风格（可点击、服务端接受）。未列出的风格一律拒收。
# ⚠️ 同步链：必须等于 HTML 中「未 disabled」的风格按钮 data-s 集合。
# `custom` 无内置提示词，服务端要求请求里带 prompt（见 routers/style.py）。
STYLE_ENABLED = ("flat", "pixel", "bead", "custom")


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
