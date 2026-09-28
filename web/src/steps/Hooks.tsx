import { useRef } from 'react'
import { slug, type Hook, type OverlayFile } from '@rsdk-webui/shared'
import { Button, Card, Chip, Field, Note, TextInput, Toggle } from '../ui.tsx'
import type { StepProps } from './types.ts'

function newFile(): OverlayFile {
  return {
    id: Math.random().toString(36).slice(2, 9),
    path: '',
    mode: '0644',
    owner: 'root:root',
    content: '',
    encoding: 'utf8',
    blob: '',
    enabled: true,
  }
}

function newHook(): Hook {
  return {
    id: Math.random().toString(36).slice(2, 9),
    name: 'my-hook',
    script: '#!/usr/bin/env bash\n# $ROOTFS 指向新构建的 rootfs\n# set -e\n',
    enabled: true,
    inRootfs: false,
  }
}

/** base64 without Buffer (browser-safe), for binary uploads */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 能按 UTF-8 解码且没有 NUL/控制字符的文件按文本保存，保持可编辑 */
function decodeAsText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? null : text
  } catch {
    return null
  }
}

export function HooksStep({ profile, patch }: StepProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingFileId = useRef<string | null>(null)

  const setFiles = (files: OverlayFile[]) => patch({ files })
  const updateFile = (id: string, p: Partial<OverlayFile>) =>
    setFiles(profile.files.map((f) => (f.id === id ? { ...f, ...p } : f)))

  const setHooks = (pre: Hook[]) => patch({ hooks: { ...profile.hooks, pre } })
  const updateHook = (id: string, p: Partial<Hook>) =>
    setHooks(profile.hooks.pre.map((h) => (h.id === id ? { ...h, ...p } : h)))

  const onPickFile = (file: File) => {
    void file.arrayBuffer().then((buffer) => {
      const id = pendingFileId.current
      pendingFileId.current = null
      if (!id) return
      const bytes = new Uint8Array(buffer)
      const text = decodeAsText(bytes)
      updateFile(
        id,
        text !== null
          ? { content: text, encoding: 'utf8', blob: '' }
          : { content: toBase64(bytes), encoding: 'base64', blob: '' },
      )
    })
  }

  return (
    <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
      <Card
        title="覆盖文件"
        hint={`${profile.files.length} 个`}
        actions={
          <Button size="sm" onClick={() => setFiles([...profile.files, newFile()])}>
            + 添加
          </Button>
        }
      >
        <div className="body">
          {profile.files.length === 0 && (
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              放 systemd unit、udev 规则、模块参数、证书等。
              文本自动识别；二进制（.dtbo、证书）以 base64 存进 profile.json。
            </p>
          )}
          {profile.files.map((file) => (
            <div
              key={file.id}
              style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--line-soft)' }}
            >
              <Field label="目标路径 (绝对路径)">
                <TextInput mono value={file.path} onChange={(v) => updateFile(file.id, { path: v })} placeholder="/etc/modprobe.d/blacklist.conf" />
              </Field>
              <div className="row">
                <Field label="权限">
                  <TextInput mono value={file.mode} onChange={(v) => updateFile(file.id, { mode: v })} />
                </Field>
                <Field label="属主">
                  <TextInput mono value={file.owner} onChange={(v) => updateFile(file.id, { owner: v })} />
                </Field>
              </div>
              {file.encoding === 'base64' ? (
                <Note tone="info">
                  已上传二进制内容 <span className="mono">{Math.round((file.content.length * 3) / 4)} 字节</span>
                </Note>
              ) : (
                <Field label="文件内容">
                  <textarea rows={4} value={file.content} onChange={(e) => updateFile(file.id, { content: e.target.value })} />
                </Field>
              )}
              <div className="row tight" style={{ alignItems: 'center' }}>
                <Toggle checked={file.enabled} onChange={(v) => updateFile(file.id, { enabled: v })} title="启用" />
                <div style={{ flex: 'none' }}>
                  <Button
                    size="sm"
                    onClick={() => {
                      pendingFileId.current = file.id
                      fileInput.current?.click()
                    }}
                  >
                    上传文件
                  </Button>
                </div>
                <div style={{ flex: 'none' }}>
                  <Button variant="danger" size="sm" onClick={() => setFiles(profile.files.filter((f) => f.id !== file.id))}>
                    删除
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="自定义脚本"
        hint={`${profile.hooks.pre.length} 个`}
        actions={
          <Button size="sm" onClick={() => setHooks([...profile.hooks.pre, newHook()])}>
            + 添加脚本
          </Button>
        }
      >
        <div className="body">
          {profile.hooks.pre.length === 0 && (
            <p className="faint" style={{ margin: 0 }}>
              还没有脚本。执行顺序：装包 → 覆盖文件 → 用户配置 → 这里 → update-initramfs。
            </p>
          )}
          {profile.hooks.pre.map((hook, index) => (
            <div
              key={hook.id}
              style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--line-soft)' }}
            >
              <div className="row">
                <Field label="名称">
                  <TextInput value={hook.name} onChange={(v) => updateHook(hook.id, { name: v })} />
                </Field>
                <Field label="生成的文件名" displayOnly>
                  <div className="mono faint" style={{ paddingTop: 8 }}>
                    customize/hooks/{String(index + 1).padStart(2, '0')}-{slug(hook.name)}.sh
                  </div>
                </Field>
              </div>
              <Field label="脚本内容">
                <textarea rows={7} value={hook.script} onChange={(e) => updateHook(hook.id, { script: e.target.value })} />
              </Field>
              <div className="row tight" style={{ alignItems: 'center' }}>
                <Toggle
                  checked={hook.inRootfs}
                  onChange={(v) => updateHook(hook.id, { inRootfs: v })}
                  title="在新系统里执行 (chroot)"
                  desc="关：在容器里跑，用 $ROOTFS 改文件。开：拷进镜像再 chroot 执行"
                />
                <Toggle checked={hook.enabled} onChange={(v) => updateHook(hook.id, { enabled: v })} title="启用" />
                <div style={{ flex: 'none' }}>
                  <Button variant="danger" size="sm" onClick={() => setHooks(profile.hooks.pre.filter((h) => h.id !== hook.id))}>
                    删除
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="执行时机" hint="定制插在 full-upgrade 之后、生成 initramfs 之前">
        <div className="body">
          <div className="chips">
            <Chip>1. apt-get full-upgrade</Chip>
            <Chip tone="accent">2. 本页的定制 ← 我们</Chip>
            <Chip>3. update-initramfs</Chip>
            <Chip>4. u-boot-update</Chip>
            <Chip>5. 生成磁盘镜像</Chip>
          </div>
          <details className="help-details">
            <summary>为什么插在 2 这个位置</summary>
            <p>
              生成的 <span className="mono">customize/install.sh</span> 追加在上游{' '}
              <span className="mono">rootfs.jsonnet</span> 的 <span className="mono">+ cleanup()</span> 之后。
              上游 <span className="mono">additional_repos.libjsonnet</span> 里的{' '}
              <span className="mono">apt-get full-upgrade</span> /{' '}
              <span className="mono">autoremove --purge</span> 更早，所以这里装的包不会被自动清理掉；
              update-initramfs / u-boot-update 更晚，所以内核模块、firmware、u-boot 的改动能正确收进
              initramfs 和引导镜像。
            </p>
          </details>
        </div>
      </Card>

      <input
        ref={fileInput}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onPickFile(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
