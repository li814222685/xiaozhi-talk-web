# Avatar 模型

请将 .glb 格式的 3D 模型放在此目录下，命名为 `avatar.glb`。

## 获取模型的方式

1. **Ready Player Me**（推荐）: https://readyplayer.me
   - 上传一张正脸照片即可生成 3D 头像
   - 导出时选择 GLB 格式
   - 确保包含 ARKit blendshape 和 Oculus viseme

2. **VRoid Studio**: https://vroid.com/studio
   - 免费桌面软件，手动捏角色
   - 导出为 VRM 格式后用 Blender 转换为 GLB

3. **Avaturn**: https://avaturn.me
   - 照片生成写实 3D 头像

## 模型要求

- 格式：GLB
- 必须包含 Mixamo 兼容骨骼
- 必须包含 ARKit blendshape (52个) 和 Oculus viseme (15个)
- Ready Player Me 默认导出即满足以上要求
