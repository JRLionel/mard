"""
抠图路由 · E5（Story 5.1 自动抠图 / Story 5.2 边带回收紧）

路径与行为与拆分前完全一致：`/cutout`、`/matting`。
图片只在内存中处理，请求结束即释放，不落盘、不记录。
"""

from __future__ import annotations

import time

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

# 算法引擎在 backend/cutout.py（与本路由文件同名但不同模块，绝对导入指向引擎）
from cutout import CutoutParams, compute_alpha, decode_image

import config

router = APIRouter()


def _load(upload: UploadFile) -> np.ndarray:
    data = upload.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="上传内容为空")
    if len(data) > config.MAX_BYTES:
        raise HTTPException(status_code=413, detail="图片超过 40MB，请先压缩后再试")
    try:
        img = decode_image(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    h, w = img.shape[:2]
    if h * w > config.MAX_PIXELS:
        raise HTTPException(status_code=413, detail="图片像素总数过大（超过 5000 万），请先缩放")
    return img


def _guided_alpha(img_bgr: np.ndarray, alpha: np.ndarray, radius: int, eps: float) -> np.ndarray:
    """
    引导滤波（He et al. 2010）的 box 实现，引导图 = 灰度原图，输入 = alpha。
    只在主体边带内作用：先腐蚀/膨胀各 radius 得到「确定内」「确定外」，
    带内用滤波结果，带外保持原值。
    """
    guide = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    p = alpha.astype(np.float32) / 255.0
    r = radius
    k = (2 * r + 1, 2 * r + 1)

    mean_g = cv2.boxFilter(guide, -1, k)
    mean_p = cv2.boxFilter(p, -1, k)
    corr_g = cv2.boxFilter(guide * guide, -1, k)
    corr_gp = cv2.boxFilter(guide * p, -1, k)
    var_g = corr_g - mean_g * mean_g
    cov_gp = corr_gp - mean_g * mean_p
    a = cov_gp / (var_g + eps)
    b = mean_p - a * mean_g
    q = cv2.boxFilter(a, -1, k) * guide + cv2.boxFilter(b, -1, k)

    hard = (alpha >= 128).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    inside = cv2.erode(hard, kernel).astype(bool)
    outside = (cv2.dilate(hard, kernel) == 0)

    out = q.copy()
    out[inside] = 1.0
    out[outside] = 0.0
    return np.clip(out * 255.0, 0, 255).astype(np.uint8)


def _checker_overlay(img_bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """把 alpha 叠在 16px 棋盘格上，供人工目视检查抠图质量。"""
    h, w = alpha.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    chk = (((yy // 16) + (xx // 16)) % 2).astype(np.uint8) * 55 + 200
    bg = np.dstack([chk, chk, chk])
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    return np.clip(img_bgr.astype(np.float32) * a + bg.astype(np.float32) * (1 - a), 0, 255).astype(np.uint8)


@router.post("/cutout")
def cutout(
    file: UploadFile = File(..., description="原图"),
    long_edge: int = Form(1024),
    border_ratio: float = Form(0.02),
    fg_ratio: float = Form(0.10),
    bg_delta: float = Form(5.0),
    feather: int = Form(1),
    keep_largest: bool = Form(True),
    preview: bool = Form(False, description="true 时返回彩色预览 PNG，否则返回 8 位灰度蒙版"),
):
    """
    自动抠图：图片进、蒙版出。返回 PNG 字节流，与原图同尺寸。

    - `preview=false`（默认）：8 位灰度 PNG，白 = 主体，黑 = 背景，中间灰 = 边缘过渡（soft alpha）
    - `preview=true`：把 alpha 叠在棋盘格上，仅用于人工目视检查
    """
    img = _load(file)
    t0 = time.perf_counter()
    params = CutoutParams(
        long_edge=max(256, min(2048, long_edge)),
        border_ratio=min(0.10, max(0.005, border_ratio)),
        fg_ratio=min(0.45, max(0.03, fg_ratio)),
        bg_delta=max(0.0, min(40.0, bg_delta)),
        feather=max(0, min(8, feather)),
        keep_largest=bool(keep_largest),
    )
    try:
        alpha = compute_alpha(img, params)
    except Exception as e:                      # noqa: BLE001 —— 任何异常都要变成可读中文提示
        raise HTTPException(status_code=500, detail=f"抠图失败：{e}")

    out = _checker_overlay(img, alpha) if preview else alpha

    ok, buf = cv2.imencode(".png", out, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise HTTPException(status_code=500, detail="蒙版编码失败")

    h, w = alpha.shape[:2]
    return Response(
        content=buf.tobytes(),
        media_type="image/png",
        headers={
            "X-Mask-Width": str(w),
            "X-Mask-Height": str(h),
            "X-Cutout-Ms": str(int((time.perf_counter() - t0) * 1000)),
            "Cache-Control": "no-store",
        },
    )


@router.post("/matting")
def matting(
    file: UploadFile = File(...),
    mask: UploadFile = File(..., description="已有蒙版（灰度 PNG）"),
    radius: int = Form(2),
    eps: float = Form(0.04),
    preview: bool = Form(False),
):
    """
    二次精修：把已有 alpha 在原图边带内做一个很小的边缘保持收边。

    `/cutout` 的输出是「格级别够用」的硬边；当用户把网格放到 104 档、
    或主体边缘是高对比细线时，硬边会出现锯齿。此接口用引导滤波把边缘拉细一档，
    对结果仍是确定性的。
    """
    img = _load(file)
    data = mask.file.read()
    m = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise HTTPException(status_code=400, detail="蒙版解码失败，请传灰度 PNG")
    if m.shape[:2] != img.shape[:2]:
        m = cv2.resize(m, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR)

    try:
        out = _guided_alpha(img, m, radius=max(1, min(8, radius)), eps=max(1e-4, eps))
    except Exception as e:                      # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"精修失败：{e}")

    if preview:
        out = _checker_overlay(img, out)
    ok, buf = cv2.imencode(".png", out, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise HTTPException(status_code=500, detail="蒙版编码失败")
    return Response(content=buf.tobytes(), media_type="image/png",
                    headers={"Cache-Control": "no-store"})
