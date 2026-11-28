# Sincronização privada do ProjetoApp

Este serviço mantém uma cópia dos dados do app no repositório privado
[danrleyjhones98/ProjetoApp-dados](https://github.com/danrleyjhones98/ProjetoApp-dados).
O token do GitHub e a chave de acesso ficam como secrets no Cloudflare Worker; não os coloque no app ou neste repositório público.

## Preparar o serviço gratuito

1. Crie ou acesse uma conta Cloudflare e instale o Node.js no computador usado para configurar o serviço.
2. No GitHub, crie um **Fine-grained personal access token** com acesso somente ao repositório `ProjetoApp-dados` e permissão **Contents: Read and write**. Não habilite outros repositórios ou permissões.
3. Crie uma chave aleatória para o app, com pelo menos 32 caracteres. No PowerShell com Node.js instalado, gere uma chave com:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Guarde essa chave em local privado. Ela será digitada também na configuração do app em cada aparelho.
4. No terminal, entre nesta pasta e publique o Worker:

   ```powershell
   Set-Location .\sync-worker
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put APP_ACCESS_KEY
   npx wrangler deploy
   ```

   Nos dois comandos `secret put`, cole o valor correspondente quando solicitado. O comando de deploy informa uma URL `https://...workers.dev`.
5. Em cada aparelho, abra **Cadastros → Sincronização segura entre aparelhos**, informe a URL do Worker e a chave aleatória, salve e toque em **Sincronizar agora**.

Não envie tokens, chaves ou dados de clientes por mensagens. Se a chave de acesso for exposta, substitua o secret `APP_ACCESS_KEY` no Cloudflare e atualize a configuração nos aparelhos.

## Comportamento e proteção contra perda

- O app continua salvando localmente. Depois da primeira sincronização, alterações online são enviadas automaticamente; sem internet ficam no aparelho até a conexão voltar.
- O primeiro aparelho com dados envia sua cópia se a nuvem estiver vazia. Um aparelho sem dados locais baixa a cópia da nuvem.
- Se os dois lados tiverem alterações diferentes, o app interrompe a sincronização. Use **Baixar dados da nuvem** para substituir este aparelho, ou **Enviar dados deste aparelho** para substituir a cópia remota. A segunda opção pode apagar alterações de outro aparelho.
- O Worker usa revisão do arquivo do GitHub para recusar gravações concorrentes, mantém o repositório privado e limita o CORS à origem pública do app.
- O histórico de commits do repositório privado contém versões anteriores do arquivo de dados. Apagar um registro no app não remove versões antigas do histórico; mantenha o repositório privado.
