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
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1] ?? ''
      const id = pendingFileId.current
      if (id) updateFile(id, { content: base64, encoding: 'base64' })
      pendingFileId.current = null
    }
    reader.readAsDataURL(file)
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
              往 rootfs 里放自己的配置文件：systemd unit、udev 规则、内核模块参数、证书……
              文本直接写内容，二进制（.dtbo、证书）可以上传，内容会以 base64 存进 profile.json。
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
                    上传二进制
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
              还没有自定义脚本。这里的脚本会在所有“附加软件包 / 覆盖文件 / 用户配置”之后、上游的
              update-initramfs 与 u-boot-update 之前执行。
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
                  desc="关闭时脚本在构建容器里运行，可用 $ROOTFS 直接改文件；开启后脚本被拷进镜像再 chroot 执行。"
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

      <Card title="执行时机" >
        <div className="body">
          <p style={{ margin: 0, fontSize: 12.5 }} className="dim">
            生成的 <span className="mono">customize/install.sh</span> 被插入到上游{' '}
            <span className="mono">rootfs.jsonnet</span> 的 <span className="mono">+ cleanup()</span> 之后。上游
            <span className="mono"> additional_repos.libjsonnet</span> 里的{' '}
            <span className="mono">apt-get full-upgrade</span> / <span className="mono">autoremove --purge</span>{' '}
            在更早的位置，所以这里装的包不会被自动清理掉；而 update-initramfs / u-boot-update 在更晚的位置，所以
            内核模块、firmware、u-boot 相关的改动都会被正确收进 initramfs 和引导镜像。
          </p>
          <hr className="sep" />
          <div className="chips">
            <Chip>1. apt-get full-upgrade</Chip>
            <Chip tone="accent">2. 本页的定制 ← 我们</Chip>
            <Chip>3. update-initramfs</Chip>
            <Chip>4. u-boot-update</Chip>
            <Chip>5. 生成磁盘镜像</Chip>
          </div>
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
