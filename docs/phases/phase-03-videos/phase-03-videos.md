---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-19T23:19:25.607951400-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-19T23:19:19.750558200-03:00"
  docs/decisions/technical-decisions-videos.md: "2026-10-19T23:17:55.845650500-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-19T22:22:22.045042800-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver upload of videos up to 10GB straight to S3-compatible storage (multipart with presigned parts, the API never carrying the bytes), a draft video row created at upload start, automatic background processing through a BullMQ queue and a separate FFmpeg worker (duration and metadata extraction plus a thumbnail from one frame), a unique URL identifier per video, streaming and download delivered by presigned redirects, and the new storage, queue and worker services running in Docker Compose.

---

## Step Implementations

### SI-03.1 — Preparar infraestrutura Docker (Infra)

**Description:** Adiciona o FFmpeg à imagem de desenvolvimento e os serviços Redis e storage S3 ao Compose, para que fila e storage existam de verdade antes de qualquer código de vídeo.

**Technical actions:**

1. Instalar o pacote apt `ffmpeg` em `nestjs-project/Dockerfile.dev`, imagem compartilhada por `nestjs-api` e `nestjs-worker`; reconstruir a imagem (`docker compose build`) (per `videos/TD-15`, `videos/TD-08`)
2. Adicionar o serviço `redis` em `nestjs-project/compose.yaml`: imagem `redis:7`, comando com `--appendonly yes --maxmemory-policy noeviction`, volume nomeado e healthcheck `redis-cli ping` (per `videos/TD-01`, `videos/TD-14`)
3. Adicionar o serviço `storage`: imagem `cgr.dev/chainguard/minio@sha256:2915cb406f38ed6ff9634de0a3e4a9423e2dda06a6f1aca18f8c968aa37a01f6`, comando `server /data --console-address ":9001"`, portas `9000` e `9001`, volume nomeado, credenciais e `MINIO_API_CORS_ALLOW_ORIGIN` via variáveis de ambiente, sem healthcheck; se o volume não for gravável pelo usuário 65532, definir `user: root` (per `videos/TD-02`, `videos/TD-14`)
4. Ligar `nestjs-api` aos novos serviços em `depends_on` (`redis` com `service_healthy`, `storage` com `service_started`)
5. Adicionar as chaves `S3_*`, `UPLOAD_MAX_BYTES`, `REDIS_*`, `VIDEO_QUEUE_NAME` e `MINIO_*` a `nestjs-project/.env.example` (per `videos/TD-14`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` lista `redis` e `storage` com status running e o healthcheck do `redis` fica healthy
- `docker compose exec redis redis-cli ping` retorna `PONG` e `redis-cli config get appendonly` retorna `yes`
- `GET http://localhost:9000/minio/health/live` retorna `200`
- `docker compose exec nestjs-api ffmpeg -version` e `ffprobe -version` terminam com código 0

---

### SI-03.2 — Instalar libs, configs e ambiente de teste (Infra)

**Description:** Instala as bibliotecas de fila e S3, cria as configs namespaced validadas por Joi e o setup do Jest que isola a fila de teste.

**Technical actions:**

1. Instalar `bullmq`, `@nestjs/bullmq`, `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` em `nestjs-project/package.json`, nas versões de `library-refs.md` (per `videos/TD-01`, `videos/TD-03`)
2. Criar `src/config/storage.config.ts` (`registerAs`) com `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `UPLOAD_MAX_BYTES` (padrão 10737418240), `UPLOAD_PART_SIZE_BYTES` (padrão 67108864) e os expiries de parte, stream, download e leitura do worker (padrões 1 h, 5 min, 15 min, 1 h; plan-build call) (per `videos/TD-14`, `phase-01-configuracao-base/TD-03`)
3. Criar `src/config/queue.config.ts` com `REDIS_HOST`, `REDIS_PORT` e `VIDEO_QUEUE_NAME` (per `videos/TD-14`)
4. Estender o schema Joi de `src/config/env.validation.ts` com as chaves novas (per `videos/TD-14`, `phase-01-configuracao-base/TD-02`)
5. Criar um arquivo de setup do Jest que define `process.env.VIDEO_QUEUE_NAME` e `S3_PUBLIC_ENDPOINT` antes do carregamento dos módulos e registrá-lo em `setupFiles` no `package.json` e em `test/jest-e2e.json` (per `videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation` (chaves de storage e fila) | Integration: chave obrigatória ausente aborta, defaults aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — as chaves e serviços existem no Compose

**Acceptance criteria:**

- A aplicação não inicia sem `S3_BUCKET`: a validação Joi aborta o carregamento da config citando a chave
- Sem `UPLOAD_MAX_BYTES` e `UPLOAD_PART_SIZE_BYTES` no ambiente, a config assume 10737418240 e 67108864
- Dentro do processo Jest, `VIDEO_QUEUE_NAME` difere do valor do `.env`, de modo que o `nestjs-worker` nunca consome jobs de teste
- `npm ls bullmq @nestjs/bullmq @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` lista as quatro bibliotecas instaladas

---

### SI-03.3 — Criar módulo de storage S3

**Description:** Encapsula o acesso ao storage S3 (multipart, assinatura, leitura, bucket) em um módulo único, com clientes separados para o endpoint interno e o público.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` com dois clientes S3 (`forcePathStyle`): um com `S3_ENDPOINT` para chamadas da API e do worker, outro com `S3_PUBLIC_ENDPOINT` apenas para assinar URLs de navegador (per `videos/TD-06`, `videos/TD-14`)
2. Implementar as operações multipart: `createMultipartUpload`, `presignUploadPart`, `listParts` (paginado), `completeMultipartUpload` e `headObject` (per `videos/TD-03`, `videos/TD-04`)
3. Implementar `presignGet` (cliente público, com `ResponseContentDisposition` opcional), `presignInternalRead` (cliente interno, para o worker) e `putObject` (thumbnail) (per `videos/TD-06`, `videos/TD-09`, `videos/TD-11`)
4. Implementar `ensureBucket()` em `onModuleInit`: HeadBucket e depois CreateBucket, repetindo com espera até o storage responder (per `videos/TD-14`, `videos/TD-02`)
5. Criar `src/storage/storage.module.ts` exportando o `StorageService` e registrá-lo no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: smoke contra o storage real (bucket, multipart por URLs assinadas com a primeira parte de 5 MiB, o mínimo do S3, ListParts, Range GET, cabeçalhos CORS) | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2 — serviço de storage e config precisam existir

**Acceptance criteria:**

- Ao subir o módulo, o bucket `S3_BUCKET` existe, inclusive na primeira execução com o storage vazio
- Um upload multipart de duas partes por URLs pré-assinadas seguido de CompleteMultipartUpload gera um objeto cujo HeadObject informa o tamanho somado das partes
- `GET` na URL pré-assinada de leitura com `Range: bytes=0-99` retorna `206` com `Content-Range`
- Uma requisição à URL pré-assinada com `Origin` de navegador recebe o cabeçalho `Access-Control-Allow-Origin`
- URLs de parte e de leitura pública são assinadas com o host de `S3_PUBLIC_ENDPOINT`; a leitura interna do worker usa o host de `S3_ENDPOINT`
- A URL de download contém `response-content-disposition=attachment`

---

### SI-03.4 — Criar entidade Video, migration, slug e exceções de domínio

**Description:** Entrega a persistência de vídeos (tabela, entidade, slug único) e os códigos de erro que as demais SIs reutilizam.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme o Data Model: enum `VideoStatus`, relação `ManyToOne` com `Channel` e `ON DELETE RESTRICT` (per `videos/TD-13`)
2. Criar a migration `<timestamp>-CreateVideos.ts` com o enum `video_status`, a tabela `videos`, o índice único em `slug` e o índice em `channel_id`, com `down` reversível (per `videos/TD-13`, `phase-01-configuracao-base/TD-04`)
3. Criar `src/videos/slug.util.ts` com `generateSlug()`: 8 bytes de `crypto.randomBytes` em base64url, 11 caracteres (per `videos/TD-07`)
4. Adicionar os 7 `DomainException` do Error Catalog em `src/common/exceptions/domain.exception.ts` (per `videos/TD-16`, `phase-02-auth/TD-07`)
5. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e importá-lo no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints (slug único, FK RESTRICT), defaults (`status = draft`), enum | `src/videos/entities/video.entity.integration-spec.ts` |
| `generateSlug` | Unit: tamanho e alfabeto base64url | `src/videos/slug.util.spec.ts` |
| migration `CreateVideos` | Integration: up e down | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Após `npm run migration:run`, a tabela `videos` existe com índice único em `slug` e chave estrangeira para `channels`
- Inserir dois vídeos com o mesmo `slug` viola o índice único
- Excluir um canal que possui vídeos falha pela restrição de chave estrangeira
- Um vídeo inserido sem `status` fica `draft`; um valor fora de `draft | processing | ready | error` é rejeitado pelo banco
- `generateSlug()` retorna 11 caracteres do alfabeto base64url
- `npm run migration:revert` remove a tabela `videos` e o tipo `video_status`

---

### SI-03.5 — Criar rascunho e abrir upload (POST /videos)

**Description:** Permite ao dono iniciar o upload: cria o rascunho no canal do usuário e abre o multipart no storage, sem que a API toque nos bytes.

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (cria no canal do próprio usuário)

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts`; o módulo de vídeos resolve o canal por ele, sem consultar a tabela de canais (per `videos/TD-12`, `videos/TD-13`)
2. Criar `src/videos/dto/create-video.dto.ts` (`filename`, `size`, `contentType`, `title`) com class-validator e decorators Swagger (per `phase-02-auth/TD-06`, `openapi-docs-nestjs/TD-01`)
3. Implementar `VideosService.createDraft(userId, dto)`: valida o teto de 10 GiB, resolve o canal, gera id, chaves e slug (nova tentativa em colisão), chama `createMultipartUpload` e persiste o rascunho (per `videos/TD-03`, `videos/TD-05`, `videos/TD-07`, `videos/TD-13`)
4. Criar `src/videos/videos.controller.ts` com `POST /videos` (`201` com `{ id, slug, status, uploadId, partSize, partCount }`), usando o decorator de usuário atual existente (per `videos/TD-16`)
5. Registrar controller e service em `VideosModule`, importando `StorageModule` e o módulo de canais, e exportar `VideosService` para o worker

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: DB contract | `src/channels/channels.service.integration-spec.ts` |
| `VideosService.createDraft` | Unit: teto de tamanho, colisão de slug (mock repo e storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration: linha `draft` no banco e upload aberto no storage real | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3, SI-03.4 — storage e entidade precisam existir

**Acceptance criteria:**

- `POST /videos` autenticado com `{ filename, size, contentType: "video/mp4" }` retorna `201` com `id`, `slug` de 11 caracteres, `status: "draft"`, `uploadId`, `partSize` igual a `UPLOAD_PART_SIZE_BYTES` e `partCount` igual a `ceil(size / partSize)`
- Após o `POST /videos`, existe uma linha em `videos` com `status = draft` no canal do usuário e um upload multipart aberto no storage
- `POST /videos` com `size` acima de 10737418240 retorna `400` com `error: "VIDEO_UPLOAD_TOO_LARGE"`
- `POST /videos` com `contentType` que não começa com `video/` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `title` grava o `filename` saneado como título
- `POST /videos` sem token retorna `401`

---

### SI-03.6 — Assinar partes do upload (POST /videos/:id/parts)

**Description:** Assina sob demanda as URLs das partes, para que o upload de 10GB não dependa de URLs que expiram antes da última parte.

**Route:** POST /videos/:id/parts
**Test Specs:** see `nestjs-project/specs/videos-parts.plan.md`
**Authorization:** Owner

**Technical actions:**

1. Criar `src/videos/dto/sign-parts.dto.ts` com `partNumbers` (inteiros, de 1 a 100 itens) (per `videos/TD-16`)
2. Implementar `VideosService.signParts(userId, videoId, partNumbers)`: dono (404), apenas `draft` (409), números dentro de 1..`partCount` (400), URLs por `presignUploadPart` com o expiry de parte (per `videos/TD-16`, `videos/TD-06`)
3. Adicionar `POST /videos/:id/parts` ao controller, respondendo `200` com `{ parts: [{ partNumber, url }] }`
4. Aplicar `@SkipThrottle()` à rota, mantendo o throttler global nas demais (per `videos/TD-17`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.signParts` | Unit: ramos de dono, estado e faixa (mock repo e storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.signParts` | Integration: URLs reais aceitam PUT de uma parte | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — o rascunho precisa existir

**Acceptance criteria:**

- `POST /videos/:id/parts` do dono com `partNumbers: [1, 2]` retorna `200` com duas URLs cujo host é o de `S3_PUBLIC_ENDPOINT`
- Um `PUT` do conteúdo de uma parte para uma URL retornada responde com o cabeçalho `ETag`
- `POST /videos/:id/parts` por outro usuário autenticado ou com id desconhecido retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `POST /videos/:id/parts` em vídeo fora de `draft` retorna `409` com `error: "VIDEO_NOT_DRAFT"`
- `POST /videos/:id/parts` com lista vazia ou número fora de 1..`partCount` retorna `400` com `error: "VIDEO_INVALID_PART"`
- Mais de 10 chamadas a `POST /videos/:id/parts` em 60 segundos não retornam `429`

---

### SI-03.7 — Criar módulo de fila BullMQ

**Description:** Registra a fila de processamento de vídeos com as opções de job decididas, compartilhada por API (produtor) e worker (consumidor).

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` com o nome do job `video.process` e as opções padrão: `attempts: 3`, backoff exponencial de base 5000 ms (plan-build call), `removeOnComplete: true`, `removeOnFail` por idade de 7 dias (plan-build call) (per `videos/TD-04`, `videos/TD-10`)
2. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` (conexão de `queue.config`) e `BullModule.registerQueue` (nome de `VIDEO_QUEUE_NAME`, `defaultJobOptions`), exportando a fila (per `videos/TD-01`, `videos/TD-14`)
3. Importar `QueueModule` em `AppModule` e em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `src/queue/queue.module.spec.ts` |
| fila `video.process` | Integration: jobId idempotente, opções padrão, remoção ao concluir (Redis real) | `src/queue/queue.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2 — Redis e config da fila precisam existir

**Acceptance criteria:**

- Enfileirar `video.process` duas vezes com o mesmo `jobId` resulta em um único job aguardando na fila
- Os jobs criados carregam `attempts: 3` e backoff exponencial de 5000 ms
- Um job concluído deixa de existir no Redis (`removeOnComplete`)

---

### SI-03.8 — Finalizar upload e enfileirar processamento (POST /videos/:id/complete)

**Description:** Fecha o multipart no storage, valida o tamanho, move o vídeo para `processing` e enfileira o job, de forma segura contra crash e repetível.

**Route:** POST /videos/:id/complete
**Test Specs:** see `nestjs-project/specs/videos-complete.plan.md`
**Authorization:** Owner

**Technical actions:**

1. Implementar `VideosService.completeUpload(userId, videoId)` para vídeo `draft`: `listParts` paginado, valida a contagem de partes (400), `completeMultipartUpload`, `headObject` contra o teto de 10 GiB (400), status `processing` e enfileiramento, nessa ordem (per `videos/TD-04`)
2. Tratar o crash: linha ainda `draft` com NoSuchUpload no ListParts faz `headObject` em `original_key`; objeto presente segue para o status e o enfileiramento, ausente lança `VIDEO_UPLOAD_EXPIRED` (per `videos/TD-04`)
3. Tratar os demais estados: `processing` pula o S3 e apenas reenfileira (`200`); `ready` ou `error` lança `VIDEO_ALREADY_FINALIZED` (per `videos/TD-16`)
4. Enfileirar `video.process` com payload `{ videoId }` e `jobId` igual a `videoId` via `@InjectQueue` (per `videos/TD-04`)
5. Adicionar `POST /videos/:id/complete` ao controller (`200` com `{ id, status }`) com decorators Swagger

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: todos os ramos (normal, crash com e sem objeto, `processing`, `ready`/`error`, partes zeradas, tamanho excedido) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: banco, storage e Redis reais | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.7 — partes enviáveis e fila precisam existir

**Acceptance criteria:**

- `POST /videos/:id/complete` do dono após o envio de todas as partes retorna `200` com `{ id, status: "processing" }` e a linha passa a `processing`
- Esse `complete` deixa na fila um job `video.process` com `jobId` igual ao id do vídeo e payload `{ videoId }`
- Um segundo `POST /videos/:id/complete` em vídeo `processing` retorna `200` sem criar job duplicado
- `POST /videos/:id/complete` em vídeo `ready` ou `error` retorna `409` com `error: "VIDEO_ALREADY_FINALIZED"`
- `POST /videos/:id/complete` sem nenhuma parte enviada retorna `400` com `error: "VIDEO_UPLOAD_INCOMPLETE"`
- Com o upload já concluído no storage e a linha ainda `draft`, `POST /videos/:id/complete` retorna `200` e o vídeo vai a `processing`
- Com o upload inexistente no storage e sem objeto, `POST /videos/:id/complete` retorna `409` com `error: "VIDEO_UPLOAD_EXPIRED"`
- `POST /videos/:id/complete` por não dono retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.9 — Consultar status do vídeo (GET /videos/:id)

**Description:** Dá ao dono a única forma de acompanhar um vídeo que ainda não está `ready`, incluindo o motivo de falha.

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-status.plan.md`
**Authorization:** Owner

**Technical actions:**

1. Criar `src/videos/dto/video-status-response.dto.ts` com `id`, `slug`, `title`, `status`, `durationSeconds`, `failureReason` e `createdAt` (conjunto de campos é plan-build call) (per `videos/TD-16`)
2. Implementar `VideosService.getOwned(userId, videoId)`: 404 para id desconhecido ou de outro dono (per `videos/TD-12`)
3. Adicionar `GET /videos/:id` ao controller com decorators Swagger

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwned` | Unit: dono e não dono (mock repo) | `src/videos/videos.service.spec.ts` |
| `VideosService.getOwned` | Integration: leitura real do banco | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — o rascunho e o controller precisam existir

**Acceptance criteria:**

- `GET /videos/:id` do dono retorna `200` com `id`, `slug`, `title`, `status`, `durationSeconds`, `failureReason` e `createdAt`
- `GET /videos/:id` de vídeo ainda não processado retorna `durationSeconds: null` e `failureReason: null`
- `GET /videos/:id` de vídeo em `error` retorna o `failureReason` preenchido
- `GET /videos/:id` por outro usuário ou com id desconhecido retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:id` sem token retorna `401`

---

### SI-03.10 — Criar entrypoint do worker e serviço no Compose

**Description:** Cria o segundo entrypoint Nest sem servidor HTTP e o serviço `nestjs-worker`, de modo que o consumidor da fila rode em um container separado da API.

**Technical actions:**

1. Criar `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)`, sem servidor HTTP, com shutdown hooks e uma linha de log de boot (per `videos/TD-08`)
2. Criar `src/worker.module.ts` importando as configs, a conexão TypeORM do `AppModule`, `StorageModule`, `QueueModule` e `VideosModule` (que exporta `VideosService`, usado por `markReady` e `markError`); o contexto standalone não abre HTTP, e o `VideoProcessor` é registrado só aqui, nunca no `VideosModule` (per `videos/TD-08`)
3. Criar `tsconfig.worker.json` (estende `tsconfig.build.json`) com `outDir` próprio `dist-worker`, adicionar `dist-worker` ao `.gitignore` e o script `start:worker` (`nest start --entryFile worker --watch -p tsconfig.worker.json`) em `nestjs-project/package.json`, para o watcher do worker não apagar o `dist/` da API (`deleteOutDir`); confirmar as flags com `nest start --help` na implementação (per `videos/TD-08`)
4. Adicionar o serviço `nestjs-worker` ao `compose.yaml`: mesmo build e volume da API, `command: npm run start:worker`, `depends_on` de `db`, `redis` e `storage`, `restart: unless-stopped`; documentar que as dependências já devem estar instaladas (`docker compose exec nestjs-api npm install`) (per `videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.3, SI-03.4, SI-03.7 — infra, storage, entidade e fila

**Acceptance criteria:**

- `docker compose ps` lista `nestjs-worker` com status running
- `docker compose logs nestjs-worker` contém a linha de boot do worker
- O container `nestjs-worker` não abre a porta 3000; a API continua atendendo apenas em `nestjs-api`
- Reiniciar `nestjs-worker` não interrompe as respostas de `nestjs-api`
- Rodar `npm run start:dev` em `nestjs-api` não reinicia nem derruba o `nestjs-worker`, e vice-versa

---

### SI-03.11 — Extrair metadados e thumbnail com FFmpeg

**Description:** Isola a chamada a `ffprobe` e `ffmpeg` em um serviço que lê o vídeo direto de uma URL de storage, sem baixar o arquivo.

**Technical actions:**

1. Criar `src/videos/media-extraction.service.ts` com `probe(url)`: `ffprobe` com saída JSON, devolvendo duração, formato e o restante do JSON para `metadata`; lança erro permanente `NoVideoStreamError` se não houver stream de vídeo (per `videos/TD-09`)
2. Implementar `extractThumbnail(url, durationSeconds)`: `ffmpeg -ss <t> -i <url> -frames:v 1` produzindo um JPEG em buffer; a regra do frame é 10% da duração, no mínimo 1 s e dentro da duração (plan-build call) (per `videos/TD-09`)
3. Implementar o helper `runProcess(command, args)` com `child_process.spawn`, capturando stderr e rejeitando por código de saída diferente de zero (per `videos/TD-09`)
4. Registrar o service no `WorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaExtractionService` | Integration: FFmpeg e storage reais (vídeo gerado com `lavfi`, lido por URL assinada interna) | `src/videos/media-extraction.service.integration-spec.ts` |
| regra do frame (`frameTime`) | Unit: proporção, piso de 1 s e limite pela duração | `src/videos/frame-time.util.spec.ts` |

**Dependencies:** SI-03.1, SI-03.3 — FFmpeg na imagem e URL assinada de leitura

**Acceptance criteria:**

- `probe` de um MP4 de 5 s gerado com `lavfi testsrc` retorna duração próxima de 5 segundos
- `probe` de um arquivo sem stream de vídeo falha com erro permanente
- `extractThumbnail` retorna bytes de um JPEG (começam com `FFD8`)
- Probe e thumbnail funcionam a partir de uma URL HTTP do storage, sem arquivo local do vídeo
- Para vídeo com duração menor que 1 s, o instante do frame fica dentro da duração

---

### SI-03.12 — Implementar o VideoProcessor e o tratamento de falha

**Description:** Consome `video.process`, move o vídeo para `ready` com duração, metadados e thumbnail, e garante o status `error` com motivo quando todas as tentativas falham.

**Technical actions:**

1. Criar `src/videos/video.processor.ts` (`@Processor` na fila de `VIDEO_QUEUE_NAME`, estendendo `WorkerHost`): `process(job)` carrega o vídeo por `videoId`, encerra se já `ready` e assina a leitura interna (per `videos/TD-04`, `videos/TD-10`)
2. Executar `probe` e `extractThumbnail`, enviar o JPEG para `videos/{id}/thumbnail.jpg` e gravar `duration_seconds`, `metadata`, `thumbnail_key` e o status `ready` (per `videos/TD-09`, `videos/TD-05`)
3. Lançar `UnrecoverableError` nas falhas permanentes, como arquivo sem stream de vídeo (per `videos/TD-10`)
4. Registrar `@OnWorkerEvent('failed')`: na última tentativa ou em `UnrecoverableError`, gravar `status = error` e `failure_reason`, o que também cobre jobs falhos por stall (per `videos/TD-10`)
5. Implementar `markReady` e `markError` em `VideosService` com transições guardadas e registrar o processor apenas no `WorkerModule` (per `videos/TD-10`, `videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: processor em processo contra Redis, storage, banco e FFmpeg reais (sucesso, já `ready`, sem stream de vídeo, falha em todas as tentativas) | `src/videos/video.processor.integration-spec.ts` |
| `VideosService.markReady/markError` | Unit: transições válidas e inválidas | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.4, SI-03.10, SI-03.11 — entidade, worker e extração

**Acceptance criteria:**

- Um job `video.process` de vídeo `processing` com arquivo válido deixa a linha `ready` com `duration_seconds` e `thumbnail_key` preenchidos e o objeto `videos/{id}/thumbnail.jpg` existente no storage
- Um job para vídeo já `ready` termina sem alterar a linha
- Um arquivo sem stream de vídeo deixa o vídeo em `error` com `failure_reason` preenchido, sem repetir as 3 tentativas
- Um job que falha nas 3 tentativas deixa o vídeo em `error` com `failure_reason`
- Uma transição inválida, como `ready` para `processing`, é recusada
- Com `nestjs-worker` parado, o job `video.process` permanece aguardando na fila

---

### SI-03.13 — Reproduzir vídeo por streaming (GET /videos/:slug/stream)

**Description:** Entrega a reprodução sem download completo, redirecionando o player para uma URL pré-assinada que o storage serve com Range.

**Route:** GET /videos/:slug/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Anonymous (apenas vídeos `ready`)

**Technical actions:**

1. Implementar `VideosService.getPlaybackUrl(slug)`: busca por `slug`, exige status `ready` (senão `VIDEO_NOT_FOUND`) e devolve a URL de `presignGet` com o expiry de stream (per `videos/TD-06`, `videos/TD-16`)
2. Adicionar `GET /videos/:slug/stream` ao controller com `@Public()` e `@SkipThrottle()`, respondendo `302` para a URL assinada (per `videos/TD-06`, `videos/TD-12`, `videos/TD-17`)
3. Documentar a resposta `302` e o `404` com decorators Swagger

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Unit: `ready` devolve URL, demais estados e slug desconhecido lançam 404 (mock repo e storage) | `src/videos/videos.service.spec.ts` |
| URL de streaming | Integration: Range na URL assinada retorna 206 do storage real | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4 — storage e entidade

**Acceptance criteria:**

- `GET /videos/:slug/stream` anônimo de vídeo `ready` retorna `302` com `Location` apontando para uma URL pré-assinada
- Um `GET` na URL do `Location` com `Range: bytes=0-99` retorna `206` com `Content-Range`
- `GET /videos/:slug/stream` de vídeo em `draft`, `processing` ou `error` retorna `404` com `error: "VIDEO_NOT_FOUND"`, inclusive para o dono
- `GET /videos/:slug/stream` com slug desconhecido retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Mais de 10 chamadas a `GET /videos/:slug/stream` em 60 segundos não retornam `429`

---

### SI-03.14 — Baixar vídeo (GET /videos/:slug/download)

**Description:** Permite o download do arquivo original como anexo, reaproveitando as mesmas checagens do streaming.

**Route:** GET /videos/:slug/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Anonymous (apenas vídeos `ready`)

**Technical actions:**

1. Estender `VideosService.getPlaybackUrl` com a opção de download: `presignGet` com `ResponseContentDisposition` de anexo e nome de arquivo saneado a partir do título e da extensão do `mime_type` (nome de arquivo é plan-build call) (per `videos/TD-11`)
2. Adicionar `GET /videos/:slug/download` ao controller com `@Public()` e `@SkipThrottle()`, respondendo `302` com expiry de download (per `videos/TD-11`, `videos/TD-17`)
3. Documentar a resposta `302` e o `404` com decorators Swagger

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` (download) | Unit: nome de arquivo saneado e checagem de status | `src/videos/videos.service.spec.ts` |
| URL de download | Integration: o storage real responde com `Content-Disposition` de anexo | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.13 — reutiliza a resolução de slug e status

**Acceptance criteria:**

- `GET /videos/:slug/download` anônimo de vídeo `ready` retorna `302` com `Location` contendo `response-content-disposition`
- Um `GET` na URL do `Location` retorna `200` com `Content-Disposition` de anexo
- Um título com caracteres inseguros (barras, aspas) gera um nome de arquivo sem esses caracteres
- `GET /videos/:slug/download` de vídeo que não está `ready` ou de slug desconhecido retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.15 — Validar o fluxo completo de upload ponta a ponta

**Description:** Prova com infraestrutura real que o ciclo inteiro funciona: rascunho, partes enviadas direto ao storage, processamento pelo worker, streaming e download.

**Technical actions:**

1. Criar um helper de teste que gera, com `ffmpeg -f lavfi -i testsrc` e bitrate alto, um vídeo curto com mais de 5 MiB (mínimo de uma parte não final no S3, senão o CompleteMultipartUpload falha com `EntityTooSmall`) e um arquivo sem stream de vídeo (per `videos/TD-15`)
2. Escrever `test/videos-flow.e2e-spec.ts`: `POST /videos`, `POST /videos/:id/parts`, `PUT` das partes nas URLs assinadas (com `UPLOAD_PART_SIZE_BYTES` de teste igual a 5 MiB para forçar mais de uma parte), `POST /videos/:id/complete`, processor em processo e `GET /videos/:id` até `ready` (per `videos/TD-15`, `videos/TD-03`)
3. Cobrir leitura pública (`stream` com Range 206 e `download`) e o caminho de erro com o arquivo sem vídeo terminando em `error`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| fluxo de vídeos | E2E: upload multipart, processamento, `ready`, streaming, download e erro | `test/videos-flow.e2e-spec.ts` |

**Dependencies:** SI-03.8, SI-03.9, SI-03.12, SI-03.14 — todos os endpoints e o processor

**Acceptance criteria:**

- Um arquivo de teste enviado em duas ou mais partes pelas URLs assinadas e finalizado com `complete` termina com `GET /videos/:id` retornando `status: "ready"` e `durationSeconds` maior que zero
- Após `ready`, `GET /videos/:slug/stream` anônimo retorna `302` e a URL do `Location` aceita `Range` com `206`
- Após `ready`, `GET /videos/:slug/download` anônimo retorna `302` para um anexo
- Um arquivo sem stream de vídeo termina em `GET /videos/:id` com `status: "error"` e `failureReason` preenchido
- Antes do processamento terminar, `GET /videos/:slug/stream` do mesmo vídeo retorna `404`

---

### SI-03.16 — Atualizar OpenAPI e documentação de IA

**Description:** Fecha a fase regenerando o contrato OpenAPI e atualizando o CLAUDE.md e o README para refletirem o estado real do código.

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export`, incluindo os 6 endpoints de vídeo e as respostas `302` (per `videos/TD-16`, `openapi-docs-nestjs/TD-02`)
2. Atualizar `nestjs-project/CLAUDE.md`: novos serviços (`redis`, `storage`, `nestjs-worker`), portas, chaves de ambiente, comando `start:worker` e a exceção documentada de que o worker sobe pelo Compose (per `videos/TD-08`)
3. Atualizar o `CLAUDE.md` da raiz com a seção de vídeos: módulo, endpoints, fila e worker, storage e estrutura de arquivos, citando apenas o que existe no código
4. Atualizar o `README.md` da raiz (arquitetura, como rodar, tabela de fases) para a Fase 03

**Tests:** _(empty — documentação e artefato gerado)_

**Dependencies:** SI-03.15 — o código final precisa estar estável

**Acceptance criteria:**

- `openapi.json` contém os caminhos `/videos`, `/videos/{id}/parts`, `/videos/{id}/complete`, `/videos/{id}`, `/videos/{slug}/stream` e `/videos/{slug}/download`
- Todo caminho de arquivo citado na seção de vídeos do `CLAUDE.md` da raiz existe no repositório
- O `nestjs-project/CLAUDE.md` lista os serviços `redis`, `storage` e `nestjs-worker` presentes no `compose.yaml`
- O `README.md` descreve a Fase 03 como concluída apenas com funcionalidades implementadas

---

## Technical Specifications

### Data Model

#### Video (table `videos`) *(per videos/TD-13, videos/TD-07, videos/TD-10)*

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK to `channels(id)`, `ON DELETE RESTRICT`, not null |
| title | varchar(255) | not null; optional at init, defaults to the sanitized original filename |
| slug | varchar(11) | unique, not null; 11-character base64url identifier from `crypto.randomBytes` |
| status | enum `video_status` (`draft`, `processing`, `ready`, `error`) | not null, default `draft` |
| upload_id | varchar | not null; the S3 multipart upload id |
| original_key | varchar | not null; `videos/{id}/original` |
| thumbnail_key | varchar | nullable; `videos/{id}/thumbnail.jpg` once generated |
| size_bytes | bigint | not null; declared size at init, re-verified at completion |
| mime_type | varchar | not null |
| duration_seconds | numeric | nullable; set by the worker |
| metadata | jsonb | nullable; remaining ffprobe output |
| failure_reason | text | nullable; set when status becomes `error` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on change |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` through `channel_id`, resolved through the channels module, never by a direct query on the channels table from the videos module.
**Indexes:** unique on `slug`; index on `channel_id`.
**Migration:** `<timestamp>-CreateVideos.ts` creates the `video_status` enum type, the `videos` table, the unique index on `slug` and the index on `channel_id` (reverted by `down`).
*(Column lengths for `varchar` fields other than `slug` and `title` are a plan-build call.)*

### API Contracts

Owner endpoints use `:id`, public endpoints use `:slug` *(per videos/TD-16)*. All error bodies follow the existing domain-exception shape (`statusCode`, `error` = the `errorCode`), established in Phase 02. Values marked *(plan-build call)* are defaults chosen by this plan, not decided TDs.

#### POST /videos (SI-03.5)

Creates the draft row and opens the S3 multipart upload *(per videos/TD-03, videos/TD-13)*. Authenticated; the video is created in the caller's channel *(per videos/TD-12)*. The global throttler applies *(per videos/TD-17)*.

**Request headers:**
- Authorization: Bearer access token
- Content-Type: application/json

**Request body:**
- filename: string, required — non-empty, max 255 characters *(plan-build call)*
- size: integer, required — bytes, min 1, max `UPLOAD_MAX_BYTES` (10 GiB = 10737418240) *(per videos/TD-14)*
- contentType: string, required — must start with `video/` *(plan-build call)*
- title: string, optional — max 255 characters; defaults to the sanitized `filename`

**Response 201:**
- id: string (uuid)
- slug: string (11 characters)
- status: `draft`
- uploadId: string
- partSize: integer — bytes per part, 64 MiB (67108864) except the last *(plan-build call)*
- partCount: integer — `ceil(size / partSize)`, at most 10000

**Error responses:**
- 400 VIDEO_UPLOAD_TOO_LARGE: `size` above `UPLOAD_MAX_BYTES`
- 400 validation error: body fails schema validation
- 401 unauthorized: missing or invalid access token
- 429 too many requests: global throttler

---

#### POST /videos/:id/parts (SI-03.6)

Signs the requested part numbers on demand for the upload in progress *(per videos/TD-16)*. Owner only, `draft` videos only. Not throttled *(per videos/TD-17)*.

**Request headers:**
- Authorization: Bearer access token
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — non-empty, each between 1 and `partCount`, at most 100 entries per call *(plan-build call)*

**Response 200:**
- parts: array of `{ partNumber: integer, url: string }` — presigned `UploadPart` URLs signed with `S3_PUBLIC_ENDPOINT`, valid for the part expiry (1 hour, *plan-build call*) *(per videos/TD-06)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id or not owned by the caller
- 409 VIDEO_NOT_DRAFT: the video is not in `draft`
- 400 VIDEO_INVALID_PART: part number outside 1..`partCount` or empty list
- 401 unauthorized: missing or invalid access token

---

#### POST /videos/:id/complete (SI-03.8)

Finalizes the upload and enqueues processing *(per videos/TD-04)*. Owner only. On a `draft` video: ListParts (paginated), CompleteMultipartUpload, HeadObject size check against the 10 GiB cap, status to `processing`, enqueue `video.process`, in that order. If the row is `draft` and ListParts fails with NoSuchUpload, HeadObject on `original_key` decides: object present continues with the status write and enqueue, absent fails with `VIDEO_UPLOAD_EXPIRED`. On a video already `processing`, the S3 steps are skipped and only the enqueue is repeated (idempotent by job id = `videoId`). The global throttler applies *(per videos/TD-17)*.

**Request headers:**
- Authorization: Bearer access token

**Response 200:**
- id: string (uuid)
- status: `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id or not owned by the caller
- 409 VIDEO_ALREADY_FINALIZED: the video is already `ready` or `error`
- 400 VIDEO_UPLOAD_INCOMPLETE: no parts uploaded, or the uploaded part count differs from `partCount`
- 400 VIDEO_UPLOAD_TOO_LARGE: stored object larger than `UPLOAD_MAX_BYTES`
- 409 VIDEO_UPLOAD_EXPIRED: upload no longer exists in storage and no object was written
- 401 unauthorized: missing or invalid access token

---

#### GET /videos/:id (SI-03.9)

Owner-only status read, the only way an owner sees a non-`ready` video *(per videos/TD-16, videos/TD-12)*.

**Request headers:**
- Authorization: Bearer access token

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: `draft` | `processing` | `ready` | `error`
- durationSeconds: number or null
- failureReason: string or null
- createdAt: string (ISO-8601)
*(response field set is a plan-build call)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id or not owned by the caller
- 401 unauthorized: missing or invalid access token

---

#### GET /videos/:slug/stream (SI-03.13)

Public (`@Public()`), no authenticated user. Resolves the slug, requires status `ready`, then answers a redirect to a short-lived presigned GET so storage serves Range (206) directly *(per videos/TD-06, videos/TD-16)*. Not throttled *(per videos/TD-17)*.

**Response 302:**
- Location: presigned GET URL for `original_key`, signed with `S3_PUBLIC_ENDPOINT`, expiry 5 minutes *(plan-build call)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown slug or status other than `ready`, for every caller including the owner

---

#### GET /videos/:slug/download (SI-03.14)

Public (`@Public()`). Same slug and status checks as streaming; answers a redirect to a presigned GET with `ResponseContentDisposition=attachment` and a sanitized filename *(per videos/TD-11)*. Not throttled *(per videos/TD-17)*.

**Response 302:**
- Location: presigned GET URL with `ResponseContentDisposition` set to an attachment disposition, expiry 15 minutes *(plan-build call)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown slug or status other than `ready`

---

All new endpoints are documented with `@nestjs/swagger` (302 responses included) and `openapi.json` is regenerated *(per videos/TD-16, openapi-docs-nestjs/TD-01, openapi-docs-nestjs/TD-02)*.

### Authorization Matrix

Owner = the authenticated user whose channel owns the video; the owner is resolved from user to channel through the channels module *(per videos/TD-12)*. A non-owner and an unknown id receive the same 404, so existence is not leaked.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (creates in own channel) | ✓ |
| POST /videos/:id/parts | ✗ | ✗ (404) | ✓ |
| POST /videos/:id/complete | ✗ | ✗ (404) | ✓ |
| GET /videos/:id | ✗ | ✗ (404) | ✓ |
| GET /videos/:slug/stream | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) |
| GET /videos/:slug/download | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) |

### Error Catalog

Codes are emitted through the existing domain-exception filter (`errorCode` + `httpStatus`), one new `DomainException` subclass per code *(per videos/TD-16, phase-02-auth/TD-07)*.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Unknown id or slug, a video the caller does not own, or a non-`ready` video on a public route |
| VIDEO_UPLOAD_TOO_LARGE | 400 | Declared size above 10 GiB at init, or stored object above the cap at completion |
| VIDEO_INVALID_PART | 400 | Part number outside 1..`partCount`, or an empty list of part numbers |
| VIDEO_UPLOAD_INCOMPLETE | 400 | Complete with zero uploaded parts, or a part count different from the declared one |
| VIDEO_NOT_DRAFT | 409 | Parts requested for a video that is not in `draft` |
| VIDEO_UPLOAD_EXPIRED | 409 | NoSuchUpload on complete and no object present in storage |
| VIDEO_ALREADY_FINALIZED | 409 | Complete on a video already `ready` or `error` |

### Events/Messages

#### video.process

Job name on the queue named by `VIDEO_QUEUE_NAME` (BullMQ on Redis).

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `videos/TD-04`)
**Consumer:** `VideoProcessor`, registered only in the worker entrypoint's module (per `videos/TD-04`, `videos/TD-08`)
**Trigger:** `POST /videos/:id/complete` after CompleteMultipartUpload succeeded and the status became `processing`; repeated calls on a `processing` video enqueue again with the same job id (per `videos/TD-04`, `videos/TD-16`)
**Delivery semantics:** at-least-once with an idempotent consumer: job id = `videoId` (a duplicate id is ignored while the previous job exists), and a job that finds the video already `ready` exits without redoing work (per `videos/TD-04`, `videos/TD-10`)

**Job options:** `attempts: 3`, exponential backoff with a 5000 ms base delay *(plan-build call)*, `removeOnComplete: true`, `removeOnFail` kept for 7 days *(plan-build call)* (per `videos/TD-10`). `UnrecoverableError` skips retries for permanent failures such as a file with no video stream. The worker `failed` listener writes `status = error` and `failure_reason` when the last attempt fails or an `UnrecoverableError` is raised, which also covers jobs failed by stalling (`maxStalledCount`, default 1) (per `videos/TD-10`).

---

## Dependency Map

SI-03.1 (root)
├── SI-03.2 — depende de SI-03.1 (chaves e serviços existem no Compose antes da config)
│   ├── SI-03.3 — depende de SI-03.1 + SI-03.2 (storage e config antes do módulo S3)
│   │   ├── SI-03.5 — depende de SI-03.3 + SI-03.4 (storage e entidade antes de abrir o upload)
│   │   │   ├── SI-03.6 — depende de SI-03.5 (rascunho antes de assinar partes)
│   │   │   │   └── SI-03.8 — depende de SI-03.6 + SI-03.7 (partes e fila antes do complete)
│   │   │   └── SI-03.9 — depende de SI-03.5 (rascunho e controller antes da consulta de status)
│   │   ├── SI-03.11 — depende de SI-03.1 + SI-03.3 (FFmpeg na imagem e URL assinada de leitura)
│   │   └── SI-03.13 — depende de SI-03.3 + SI-03.4 (storage e entidade)
│   │       └── SI-03.14 — depende de SI-03.13 (reaproveita slug e status)
│   └── SI-03.7 — depende de SI-03.1 + SI-03.2 (Redis e config da fila)
│       └── SI-03.10 — depende de SI-03.1 + SI-03.3 + SI-03.4 + SI-03.7 (worker usa storage, entidade e fila)
│           └── SI-03.12 — depende de SI-03.4 + SI-03.10 + SI-03.11 (processor precisa do worker e da extração)
SI-03.4 (root, independente)
SI-03.15 — depende de SI-03.8 + SI-03.9 + SI-03.12 + SI-03.14 (fluxo ponta a ponta usa todos os endpoints e o processor)
└── SI-03.16 — depende de SI-03.15 (documentar com o código estável)

---

## Deliverables

- [x] SI-03.1 — Preparar infraestrutura Docker (Infra)
- [x] SI-03.2 — Instalar libs, configs e ambiente de teste (Infra)
- [x] SI-03.3 — Criar módulo de storage S3
- [x] SI-03.4 — Criar entidade Video, migration, slug e exceções de domínio
- [x] SI-03.5 — Criar rascunho e abrir upload (POST /videos)
- [x] SI-03.6 — Assinar partes do upload (POST /videos/:id/parts)
- [x] SI-03.7 — Criar módulo de fila BullMQ
- [x] SI-03.8 — Finalizar upload e enfileirar processamento (POST /videos/:id/complete)
- [x] SI-03.9 — Consultar status do vídeo (GET /videos/:id)
- [x] SI-03.10 — Criar entrypoint do worker e serviço no Compose
- [x] SI-03.11 — Extrair metadados e thumbnail com FFmpeg
- [x] SI-03.12 — Implementar o VideoProcessor e o tratamento de falha
- [x] SI-03.13 — Reproduzir vídeo por streaming (GET /videos/:slug/stream)
- [x] SI-03.14 — Baixar vídeo (GET /videos/:slug/download)
- [x] SI-03.15 — Validar o fluxo completo de upload ponta a ponta
- [x] SI-03.16 — Atualizar OpenAPI e documentação de IA

**Infraestrutura:**

- [x] `cd nestjs-project && docker compose up -d` sobe `db`, `mailpit`, `redis`, `storage`, `nestjs-api` e `nestjs-worker`, todos em status running (`docker compose ps`)

**Full test suites:**

- [x] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [x] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
