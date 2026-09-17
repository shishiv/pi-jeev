# Jev no Pi

A extensão oferece `jev_decide` para comparar alternativas com evidência e receber uma recomendação tipada do Jev.
Ela não executa a alternativa escolhida.

## Usar

A extensão está instalada globalmente em `~/.pi/agent/extensions/jev/` e incluída na lista global de extensões do Pi.
Fica disponível aos agentes Pi que usam esse diretório de configuração, em qualquer projeto.
Instâncias com outro `PI_CODING_AGENT_DIR` precisam da própria instalação.
Não é uma extensão para Claude Code ou outros programas.
Na conversa que vai usá-la:

```text
/reload
/jev on
```

`/jev on` grava `{"enabled":true}` em `~/.pi/agent/jev.json`.
`/jev off` grava `{"enabled":false}` no mesmo arquivo.
A escrita é atômica e o arquivo usa permissão 0600.
A configuração é global, não pertence à conversa que executou o comando.
`/jev status` mostra a configuração global, a aplicação neste agente e o thinking efetivo.
Arquivo ausente significa desligado.
Não existe flag de ativação por sessão.

Cada instância carregada verifica o arquivo a cada segundo e nos limites de resposta.
Agentes livres aplicam a mudança em até aproximadamente um segundo.
Agentes ocupados aguardam o fim da resposta em andamento.
A mudança não inicia novos turnos nem chamadas de API.
Sessões novas, retomadas e forks consultam a mesma configuração global.
Agentes já abertos precisam de um `/reload` inicial para carregar esta extensão; depois acompanham as alterações sem novos reloads.
Ao desligar, cada agente restaura seu próprio nível anterior, quando a extensão foi quem o desligou.
Sem ativação, não há instrução adicional, ferramenta ativa ou chamada à TypeSafe.

Ao ligar, a extensão consulta as capacidades do modelo executor e solicita thinking `off` somente quando suportado.
Ela confere o nível efetivo depois da alteração.
Se o catálogo não oferecer `off`, Jev continua disponível, o nível anterior permanece e o limite é informado.
No ensaio com `azure-openai-responses/gpt-6-astra`, o Pi não ofereceu `off` e enviou `reasoning.effort=high`.
A extensão não muda o modelo nem modifica defaults globais.

O histórico privado guarda somente o ponto de restauração do thinking, nunca a autoridade para ativar Jev.
Trocar o modelo reaplica a configuração global conforme as capacidades do novo executor.
Uma alteração manual de thinking é respeitada sem desligar Jev globalmente.
Configuração inválida ou ilegível é informada e desativa o modo local no próximo limite seguro.

## O que vai para a API

`jev_decide` recebe uma pergunta, um contexto textual e duas a oito alternativas com identificadores únicos.
A extensão adiciona a alternativa `need_more_evidence`.
Somente esses dados são enviados a `https://api.typesafe.ai/v1/systemone`, usando `jev-latest`.
Não há coleta automática de arquivos, histórico, instruções da sessão ou resultados de outras ferramentas.
O contexto deve conter somente material autorizado para processamento externo.
A comparação com a própria chave evita seu envio acidental no corpo, mas não é um detector geral de segredos.

A chave é lida de `TYPESAFE_API_KEY` no ambiente ou do `.env` do diretório do Pi.
O arquivo é interpretado como dotenv, nunca executado como shell.
A chave não entra nos argumentos da ferramenta, nos resultados ou em logs da extensão.

A resposta inclui recomendação, distribuição de probabilidades, confiança, modelo real, tokens e duração.
Confiança não é prova nem autorização.
Jev escolhe entre alternativas propostas pelo executor; ele não gera um plano completo ou código e não remove capacidades internas do modelo.
A orientação para consultá-lo antes de decisões é uma instrução ao agente, não um bloqueio mecânico de todas as outras ferramentas.

## Falhas e consumo

Uma execução faz no máximo uma requisição, com prazo de quinze segundos e cancelamento ao interromper a tarefa ou fechar a sessão.
Desligar globalmente durante uma resposta não interrompe essa resposta; a desativação ocorre quando o agente fica livre.
Não há retries automáticos ou redirecionamentos HTTP.
Entradas inválidas, respostas incoerentes, erro de rede e HTTP não são convertidos em recomendações.
Corpos de erro do serviço não são reproduzidos.
A resposta é limitada a 32 KiB e o corpo enviado a 64 KiB.

O consumo informado pelo Jev aparece no resultado da ferramenta.
O preço não vem nessa resposta, portanto não é estimado nem somado como custo zero ao total do Pi.
Qualidade, economia e latência em tarefas reais ainda precisam de avaliação.

## Verificar

```sh
/usr/bin/node --test --test-concurrency=1 ./jev.test.mjs
```

Os testes usam o carregador instalado do Pi e fixtures somente para os contratos locais.
`PI_TEST_PACKAGE_DIR` permite indicar outra instalação do Pi.
A compatibilidade HTTP foi verificada separadamente por uma chamada real com dados sintéticos.
O ensaio não equivale a aceite de experiência de uso nem a comparação de qualidade com reasoning nativo.

Para desligar em todos os agentes, use `/jev off` uma única vez em qualquer sessão com a extensão carregada.
Para impedir também seu carregamento, remova `+extensions/jev/index.ts` da lista global e acrescente `-extensions/jev/index.ts` enquanto os arquivos continuarem no diretório de descoberta.
Execute `/reload` nas sessões abertas depois dessa alteração de instalação.
Remover apenas a inclusão explícita não é um desligamento garantido quando a descoberta padrão estiver habilitada.
Não há alteração em outras extensões, ferramentas de execução ou regras de autorização.
