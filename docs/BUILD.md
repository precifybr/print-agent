# Build e distribuicao

Este aplicativo e um helper desktop privado do ecossistema DALMAGO.

## Empacotamento

Comandos preparados:

- `npm run pack`: gera uma pasta local empacotada para validacao.
- `npm run dist:win`: gera o instalador Windows NSIS em `dist/`.

Nao gere release publica antes de validar impressao real, tray, autostart,
logs e assinatura de codigo.

## SmartScreen e antivirus

Builds sem assinatura podem acionar alertas do Windows SmartScreen,
especialmente nas primeiras instalacoes. Isso e esperado para executaveis
novos e nao assinados.

Para producao, usar:

- certificado de assinatura de codigo
- instalador NSIS assinado
- executavel assinado
- artefatos versionados e estaveis

Nao usar persistencia suspeita, scripts PowerShell escondidos, ofuscacao,
codigo auto-modificavel ou atalhos fora do fluxo padrao do Electron Builder.

Neste ambiente local, `win.signAndEditExecutable` fica desativado para evitar
falha do cache `winCodeSign` quando o Windows nao permite criar symlinks. Em
uma maquina de build com Developer Mode/assinatura configurada, reativar a
edicao/assinatura do executavel para embutir metadados e icone diretamente no
`.exe`.

## Icone

O instalador usa `build/icon.ico`, criado a partir da arte enviada do Print
Assistant. Guarde tambem `build/icon.png` como fonte visual. Para producao, o
icone deve ter boa legibilidade em 256x256, 48x48, 32x32 e 16x16.

## Artefato esperado

O nome do instalador segue:

`PrintAssistant Setup ${version}.exe`
