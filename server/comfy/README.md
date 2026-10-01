# Шаблоны ComfyUI для локальной 3D

`image_to_model.json` и `multi_views.json` — шаблоны Comfy-Org «Pixal3D & TRELLIS.2: Image to Model» и «Pixal3D Multi Views»
из [Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates) (MIT), без изменений.
`server/comfy3d.py` переводит их в API-формат по `/object_info` и правит узлы по id (сиды, черновик без апскейла, картинка для текстуры, ракурсы).
Обновили ComfyUI и шаблон — перекачай файлы отсюда же и проверь id узлов в `comfy3d.N`.
