"""
风格化生成路由 · E8（Story 8.2）

路径保持 `/style-transfer`（不加前缀，与已跑通的前端调用一致）。
前端只发「原图 + 风格 key」，提示词由服务端内置（Story 8.1：提示词对用户不可见）。
代理负责模型调用与密钥管理，密钥不下发前端。
"""

from __future__ import annotations

import time

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

import config
from services import aliyun_api

router = APIRouter()


@router.post("/style-transfer")
def style_transfer(
    file: UploadFile = File(..., description="原图"),
    style: str = Form("flat", description="风格 key，必须在 config.STYLE_ENABLED 内"),
    prompt: str = Form("", description="提示词覆盖（可选，留空用内置提示词）"),
):
    """
    风格化生成：原图进、风格图出。返回 PNG 字节流。

    - `style`：仅接受已开放的风格（当前只有 `flat`），其余返回 400
    - `prompt`：可选覆盖；前端不发送，提示词默认全部由服务端内置
    """
    if not config.is_style_enabled(style):
        raise HTTPException(status_code=400, detail=f"风格「{style}」暂未开放")
    if not config.style_transfer_ready():
        raise HTTPException(
            status_code=503,
            detail="风格化服务未配置：请在 .env 里设置 ALIYUN_API_KEY 与 ALIYUN_BASE_URL",
        )

    image_data = file.file.read()
    mime_type = file.content_type or "image/png"

    t0 = time.perf_counter()
    try:
        data_url = aliyun_api.encode_image(image_data, mime_type)
        image_url = aliyun_api.generate_image(
            prompt or config.get_style_prompt(style),
            data_url,
            config.get_style_negative(style),
        )
        png = aliyun_api.download_image(image_url)
    except aliyun_api.AliyunError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

    return Response(
        content=png,
        media_type="image/png",
        headers={
            "X-Style-Type": style,
            "X-Style-Ms": str(int((time.perf_counter() - t0) * 1000)),
            "Cache-Control": "no-store",
        },
    )
