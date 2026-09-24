"""
拼豆图纸转换器 · 后端服务入口

职责：FastAPI 实例化、中间件、路由注册。业务逻辑在各 routers/ 模块里。

启动：
    cd backend && python3 -m uvicorn app:app --port 8000
或：
    cd backend && python3 app.py

接口：
    GET  /health          健康检查
    POST /cutout          自动抠图，返回 soft alpha
    POST /matting         二次精修（把 alpha 在主体边带内收紧）
    POST /style-transfer  风格化生成（P2 智能转换）

隐私：图片只在内存中处理，请求结束即释放，不落盘、不记录。
"""

from __future__ import annotations

import cv2
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import config
from routers import cutout, style

app = FastAPI(title="拼豆图纸转换器 · 后端服务", version="2.0.0")

# 本地开发：允许任意来源。前端可能是 file://（Origin: null）或本地 http 服务。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Cutout-Ms", "X-Mask-Width", "X-Mask-Height", "X-Style-Ms", "X-Style-Type"],
)

app.include_router(cutout.router)
app.include_router(style.router)


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "mard-backend",
        "engine": "opencv-watershed",   # 确定性引擎；grabCut 实测不可复现，已弃用（见 cutout.py 顶部说明）
        "cv2": cv2.__version__,
        "deterministic": True,
        "style_transfer": config.style_transfer_ready(),   # 风格化是否可用（密钥是否配置）
        "styles_enabled": list(config.STYLE_ENABLED),      # 已开放的风格 key
    }


@app.exception_handler(HTTPException)
def _http_error(request, exc: HTTPException):
    # 前端读 `error` 字段取中文提示，字段名不可改
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


if __name__ == "__main__":
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser(description="拼豆图纸转换器 · 后端服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--reload", action="store_true")
    args = ap.parse_args()
    uvicorn.run("app:app", host=args.host, port=args.port, reload=args.reload)
