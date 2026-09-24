"""
阿里云百炼 · 千问-图像生成与编辑 3.0 调用封装

只负责「把图送出去、把图取回来」：编码 → 生成 → 下载。不含业务判断，
不碰 FastAPI（路由层负责参数校验与 HTTP 语义）。

接口文档：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference
采用 OpenAI 兼容模式：POST {base_url}/images/generations
文生图与图生图共用一个接口 —— 传 `image` 字段即为图生图。
"""

from __future__ import annotations

import base64

import requests

import config

# 阿里云接受的输入图片格式
SUPPORTED_MIME = ("image/jpeg", "image/png", "image/webp", "image/bmp")


class AliyunError(Exception):
    """带 HTTP 语义的调用失败。路由层直接把它转成同状态码的中文提示。"""

    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def encode_image(image_data: bytes, mime_type: str = "image/png") -> str:
    """编码为阿里云要求的 data URL 形式。"""
    if mime_type not in SUPPORTED_MIME:
        raise AliyunError("不支持的图片格式，请使用 JPG、PNG、WebP 或 BMP", 400)
    if not image_data:
        raise AliyunError("上传内容为空", 400)
    encoded = base64.b64encode(image_data).decode("utf-8")
    return f"data:{mime_type};base64,{encoded}"


def generate_image(prompt: str, image_data_url: str, negative: str = "") -> str:
    """调用图生图，返回生成图片的临时 URL（有效期 24 小时）。"""
    if not config.style_transfer_ready():
        raise AliyunError("阿里云 API 密钥未配置（.env 里的 ALIYUN_API_KEY / ALIYUN_BASE_URL）")

    payload = {
        "model": config.ALIYUN_MODEL,
        "prompt": prompt,
        "image": image_data_url,
        "size": "1024x1024",
        "n": 1,                              # 只出一张：多图会各自成图，不能拼在一起当图纸
        "prompt_extend": config.STYLE_PROMPT_EXTEND,
        "watermark": False,
    }
    # 负向提示词：堵住「多格拼贴 / 多主体」这条随机跑偏的路（见 config.py 的提示词红线）
    if negative:
        payload["negative_prompt"] = negative
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.ALIYUN_API_KEY}",
    }

    try:
        resp = requests.post(
            f"{config.ALIYUN_BASE_URL}/images/generations",
            json=payload,
            headers=headers,
            timeout=config.STYLE_TIMEOUT,
        )
    except requests.exceptions.Timeout:
        raise AliyunError("风格化生成超时（超过 60 秒），请稍后重试", 504)
    except requests.exceptions.RequestException as e:
        raise AliyunError(f"连不上风格化服务：{e}")

    if resp.status_code != 200:
        raise AliyunError(f"模型调用失败（HTTP {resp.status_code}）：{_error_message(resp)}")

    try:
        body = resp.json()
    except ValueError:
        raise AliyunError("模型返回的不是 JSON，无法解析")

    items = body.get("data") or []
    if not items or not items[0].get("url"):
        raise AliyunError("模型没有返回图片")

    return items[0]["url"]


def download_image(url: str) -> bytes:
    """把生成结果取回内存。"""
    try:
        resp = requests.get(url, timeout=config.API_TIMEOUT)
    except requests.exceptions.Timeout:
        raise AliyunError("下载生成图片超时", 504)
    except requests.exceptions.RequestException as e:
        raise AliyunError(f"下载生成图片失败：{e}")

    if resp.status_code != 200:
        raise AliyunError(f"下载生成图片失败（HTTP {resp.status_code}）")
    if not resp.content:
        raise AliyunError("下载到的图片是空的")
    return resp.content


def _error_message(resp: requests.Response) -> str:
    """尽量从错误响应里挖出可读信息，挖不到就退回原文片段。"""
    try:
        err = resp.json().get("error") or {}
        return err.get("message") or err.get("code") or resp.text[:200]
    except ValueError:
        return (resp.text or "无响应内容")[:200]
