from copy import copy

from fastapi import APIRouter, FastAPI, Response
from fastapi import HTTPException as FastApiHTTPException
from fastapi.requests import Request
from fastapi.responses import PlainTextResponse
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app_distribution_server.config import (
    APP_TITLE,
    APP_VERSION,
)
from app_distribution_server.errors import (
    UserError,
    status_codes_to_default_exception_types,
)
from app_distribution_server.routers import (
    api_router,
    app_files_router,
    health_router,
    html_router,
    transfer_router,
)

app = FastAPI(
    title=APP_TITLE,
    version=APP_VERSION,
    summary="Simple, self-hosted iOS/Android app distribution server.",
    description="[Source code, issues and documentation](https://github.com/significa/app-distribution-server)",
)

app.mount("/static", StaticFiles(directory="static"), name="static")


def add_head_routes(router: APIRouter) -> APIRouter:
    """
    Creates HEAD routes for all the GET routes in the given router.
    The route is handled by the same handler.
    Waiting on: https://github.com/fastapi/fastapi/issues/1773
    """
    for route in router.routes:
        if isinstance(route, APIRoute) and "GET" in route.methods:
            new_route = copy(route)
            new_route.methods = {"HEAD"}
            new_route.include_in_schema = False
            router.routes.append(new_route)

    return router


app.include_router(api_router.router)
app.include_router(transfer_router.router)
app.include_router(add_head_routes(html_router.router))
app.include_router(add_head_routes(app_files_router.router))
app.include_router(health_router.router)


@app.exception_handler(UserError)
async def exception_handler(
    request: Request,
    exception: FastApiHTTPException | StarletteHTTPException,
) -> Response:
    if request.url.path.startswith("/api/"):
        return PlainTextResponse(content=exception.detail, status_code=exception.status_code)

    return await html_router.render_error_page(request, exception)


@app.exception_handler(StarletteHTTPException)
async def starlette_exception_handler(
    request: Request,
    exception: StarletteHTTPException,
) -> Response:
    filtered_exception = status_codes_to_default_exception_types.get(exception.status_code)
    if filtered_exception:
        return await exception_handler(request, filtered_exception())

    return await exception_handler(request, exception)
