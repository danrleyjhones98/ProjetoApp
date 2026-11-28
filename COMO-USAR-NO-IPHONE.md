# Como usar no iPhone

O projeto é um aplicativo web (PWA), não um arquivo de aplicativo iOS (`.ipa`). Para que o layout, o JavaScript e o modo offline funcionem, publique os arquivos em um endereço HTTPS e abra esse endereço no Safari. Copiar ou abrir somente `index.html` pelo app Arquivos não instala o aplicativo e pode exibir o conteúdo como texto.

## Publicar gratuitamente com GitHub Pages

1. Crie um repositório no GitHub e envie para a raiz dele os seis arquivos do projeto: `index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js` e `icon.svg`.
2. No repositório, abra **Settings > Pages**.
3. Em **Build and deployment**, selecione **Deploy from a branch**, escolha a branch principal e a pasta **/(root)** e salve.
4. Aguarde o GitHub Pages publicar e copie o endereço HTTPS informado nessa página.
5. No iPhone, abra esse endereço no **Safari**. Toque em **Compartilhar > Adicionar à Tela de Início** e confirme.
6. Abra o ícone criado na tela inicial. Depois da primeira abertura com internet, o aplicativo também poderá carregar offline.

Não renomeie nem separe os arquivos: eles precisam continuar juntos na mesma pasta. Os dados ficam salvos no navegador/aparelho em que foram cadastrados. Para sincronizar aparelhos, é necessário publicar o serviço privado descrito em [sync-worker/README.md](./sync-worker/README.md) e configurar o endereço e a chave em **Cadastros > Sincronização segura entre aparelhos**. Até essa configuração ser concluída, os dados permanecem somente no aparelho. Para uma transferência manual, use **Backup JSON** no computador e **Restaurar** no iPhone.

No cadastro de **Itens do estoque**, nome, categoria, unidade e medida são opcionais; informe somente os detalhes disponíveis.
