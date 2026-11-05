/**
 * GIF 测试夹具（**base64 内嵌**，不依赖任何本机文件）。
 *
 * ## 为什么是内嵌的字节，而不是"测试时现造"
 *
 * 这些 GIF 是**用 Pillow 12.3 生成的**（`shared/tmp/make-gif-fixtures.py`），
 * 也就是说它们是**一个独立实现编出来的真实文件**，不是我们自己拼的字节 ——
 * 拿它去测 `src/dsh/gif.mjs` 里那个手写解码器，才算交叉验证
 * （自己写编码器再自己解，等于自说自话）。
 *
 * 生成参数与实测对账结果（PIL 解出来的帧数与像素 sha256 与 JS 侧**逐帧相同**，
 * 唯一的差别在全透明像素的 RGB：PIL 保留调色板颜色，我们写 0 —— 见报告 §三）：
 *
 * | 常量 | 尺寸 | 帧 | 特点 |
 * |---|---|---|---|
 * | {@link GIF_6FRAMES} | 200×120 | 6 | 纯色全幅，考基础解码 |
 * | {@link GIF_PARTIAL} | 160×160 | 5 | **局部帧**（每帧只覆盖一小块），考"要合成到上一帧上" |
 * | {@link GIF_INTERLACE} | 120×90 | 4 | **隔行**存储（4-pass） |
 * | {@link GIF_2FRAMES} | 80×80 | 2 | 只有两帧 |
 * | {@link GIF_1FRAME} | 64×64 | 1 | **静图**（扩展名是 gif 但只有一帧 —— 小鲸鱼那张 `img1.gif` 就是这种） |
 * | {@link GIF_TRANSPARENT} | 100×100 | 4 | 透明 + `disposal=2` |
 * | {@link GIF_LARGE} | 400×400 | 3 | 大画布 |
 * | {@link GIF_WIDE} | 600×200 | 4 | 宽画布：考拼图**必须把每帧缩小**才不超总宽上限 |
 *
 * @module qq-gugu/test-fixtures/gif-bytes
 */


/** syn-a-6frames.gif（1725 字节） */
export const GIF_6FRAMES =
  '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'
  '';

/** syn-b-partial.gif（1115 字节） */
export const GIF_PARTIAL =
  'R0lGODlhoACgAIEAAPDw8MgeHgAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACAAAACwAAAAAoACgAAAI/wABCBxIsKDBgwgT' +
  'KlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3K' +
  'tKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTKy4aoLHj' +
  'x5AjS54M+S7ly5gxW87MuXOAzZ5DTwYturRj0qZLo04dejXrzq5fZ44t+zLt2qPt4m6tezfs3r5nAw9uezjx3HWPazauvDLz5qef' +
  'Q/8sHfpt5dePZye+PXh33993h2nHPb52ednnX6dnvT51e9PvVVdvHl90fd7Jp0e+75n/78UABijggAQWaOCBCCao4IIMNujggxBG' +
  'KOGEFFZo4YUYZqjhhhx26OGHIIYo4ogklmjiiSimqOKKLLbo4oswxijjjDTWaGOIAQEAIfkEAQgAAgAsNwA8AC4AKQCB8PDwyEYe' +
  'AAAAAAAACIsAAwgcSLCgwYMICwJYuDChw4cPGTaESLFiAIkALGp0iHGjR4MdP4q8KHGkyJAmN6JMaXElS4ouX0YsKbNizJoIb+IE' +
  'SXMnx54+cwINypMh0YQ6jyYlujRoU59Pd0bFObVmVZlXX2ZluTVlV5NfR4Y9OfTowLEf0XpUq7KsWZJG3yp0a5atRrstJQYEACH5' +
  'BAEIAAIALDIAPAAuACkAgfDw8MhuHgAAAAAAAAiLAAMIHEiwoMGDCAsCWLgwocOHDxk2hEixYgCJACxqdIhxo0eDHT+KvChxpMiQ' +
  'JjeiTGlxJUuKLl9GLCmzYsyaCG/iBElzJ8eePnMCDcqTIdGEOo8mJbo0aFOfT3dGxTm1ZlWZV19mZbk1ZVeTX0eGPTn06MCxH9F6' +
  'VKuyrFmSRt8qdGuWrUa7LSUGBAAh+QQBCAACACwtADwALgApAIHw8PDIlh4AAAAAAAAIiwADCBxIsKDBgwgLAli4MKHDhw8ZNoRI' +
  'sWIAiQAsanSIcaNHgx0/irwocaTIkCY3okxpcSVLii5fRiwps2LMmghv4gRJcyfHnj5zAg3KkyHRhDqPJiW6NGhTn093RsU5tWZV' +
  'mVdfZmW5NWVXk19Hhj059OjAsR/RelSrsqxZkkbfKnRrlq1Guy0lBgQAIfkEAQgAAgAsKAA8AC4AKQCB8PDwyL4eAAAAAAAACIsA' +
  'AwgcSLCgwYMICwJYuDChw4cPGTaESLFiAIkALGp0iHGjR4MdP4q8KHGkyJAmN6JMaXElS4ouX0YsKbNizJoIb+IESXMnx54+cwIN' +
  'ypMh0YQ6jyYlujRoU59Pd0bFObVmVZlXX2ZluTVlV5NfR4Y9OfTowLEf0XpUq7KsWZJG3yp0a5atRrstJQYEADs='
  '';

/** syn-c-interlace.gif（837 字节） */
export const GIF_INTERLACE =
  'R0lGODlheABaAIEAAAoUHgAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQABgAAACwAAAAAeABaAAAIqAABCBxIsKDBgwgT' +
  'KlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3K' +
  'tKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHj' +
  'x5AjSy4aEAAh+QQBBgABACwAAAAAeABaAIHICgoAAAAAAAAAAAAIqAABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPH' +
  'jyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DD' +
  'ih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjSy4aEAAh+QQBBgABACwAAAAAeABa' +
  'AIEKyAoAAAAAAAAAAAAIqAABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJ' +
  's6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67d' +
  'u3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjSy4aEAAh+QQBBgABACwAAAAAeABaAIEKCsgAAAAAAAAAAAAIqAABCBxIsKDB' +
  'gwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iT' +
  'Kl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17M' +
  'uLHjx5AjSy4aEAA7'
  '';

/** syn-d-2frames.gif（359 字节） */
export const GIF_2FRAMES =
  'R0lGODlhUABQAIEAAAAAAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQABQAAACwAAAAAUABQAAAIggABCBxIsKDBgwgT' +
  'KlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3K' +
  'tKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3CRBgQAIfkEAQUAAQAsAAAAAFAAUACB////AAAAAAAAAAAA' +
  'CIIAAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybKly5cwY8qcSbOmzZs4c+rcybOnz59A' +
  'gwodSrSo0aNIkypdyrSp06dQo0qdSrWq1atYs2rdyrWr169gw4odS7as2bNo06pdy7at27dwkQYEADs='
  '';

/** syn-e-1frame.gif（144 字节） */
export const GIF_1FRAME =
  'R0lGODdhQABAAIEAAHstQwAAAAAAAAAAACwAAAAAQABAAEAIaQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBD' +
  'ihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izagUQEAA7'
  '';

/** syn-f-transparent.gif（1264 字节） */
export const GIF_TRANSPARENT =
  'R0lGODlhZABkAIEAAAAAAP94AAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJCQAAACwAAAAAZABkAAAI/wABCBxIsKDBgwgT' +
  'KlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJkmSAlzBhtlwZs6bNmSVt6ryJ8+POnzx7agRKNKbQjEWTvjxq' +
  'UalTphOdSoUKUapVqg2tasW6UOtVrgi9bgVrUOxXsgPNjkULQO1ZtG6nso37litduWTvPoWrN+ncvkX/AgYqePDOwoaDgk38k21b' +
  'xjUdP4Ys0zFlo5IvB5AsUDPnzpA/g2YsevTg0mlPo06td3XB1q5fx4190C3thF5vM9yr22Hj3sCDCx9OvLjx48iTK1/OvLnz59Cj' +
  'S59Ovbr169iza9/Ovbv37+DDixMfT768+fPo06tfz769+/fwnwcEACH5BAkJAAAALAAAAABkAGQAgQAAAP94AAAAAAAAAAj/AAEI' +
  'HEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKFOqXMmSZYCXMGG2XBmzps2ZJW3qvInz486fPHtqBEo0' +
  'ptCMRZO+PGpRqVOmE51KhQpRqlWqDa1qxbpQ61WuCL1uBWtQ7FeyA82ORQtA7Vm0bqeyjfuWK125ZO8+has36dy+Rf8CBip48M7C' +
  'hoOCTfyTbVvGNR0/hizTMWWjki8HkCxQM+fOkD+DZix69ODSaU+jTq13dcHWrl/HjX3QLe2EXm8z3KvbYePewIMLH068uPHjyJMr' +
  'X868ufPn0KNLn069uvXr2LNr3869u/fv4MOLEx9Pvrz58+jTq1/Pvr379/CPBwQAIfkECQkAAAAsAAAAAGQAZACBAAAA/3gAAAAA' +
  'AAAACP8AAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybLlwQAwY8Z0qVKmzZs0Sd7ciTOn' +
  'R55Ae/rMGLSozKEYjSqFibTi0qdNJT6dGvXh1KtVGV7dmlXhVqxdX34FG5bgWLJlAZzlmlbtWqpt38ItKxdt1rpzu+KFSnev0rR+' +
  '//YNHBQw4cKDD+80rHgx48Yz40I+Knky07ZuJ2MWaDnAZs6QP4NuLHo04dIDD6M263d1wb2uDdaNLfYs7YRfb2tdqhsi0N7Agwsf' +
  'Try48ePIkytfzry58+fQo0ufTr269evYs2vfzr279+/gw4sTH0++vPnz6NOrX8++vfv38IEHBAAh+QQJCQAAACwAAAAAZABkAIEA' +
  'AAD/eAAAAAAAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsuXDADBjxnSpUqbN' +
  'mzRJ3tyJM6dHnkB7+swYtKjMoRiNKoWJtOLSp00lPp0a9eVUqlUXXt2aVeHWq10RfuUatuBYsGUHniWbdi3atm6hwo0rNyxdrHbv' +
  'Lp2rtyjfvkD/At4peLDNwoZnlk0cGLHhtAIZC10s+ShkAJWZXsaceXNkyZ4/Mw4tejBptaZPo9ar2uzd1gbpwj7odnbCr7YZ1s3d' +
  'sDHv38CDCx9OvLjx48iTK1/OvLnz59CjS59Ovbr169iza9/Ovbv37+DDixIfT768+fPo06tfz769+/ehAwIAOw=='
  '';

/** syn-g-large.gif（2172 字节） */
export const GIF_LARGE =
  'R0lGODlhkAGQAYEAAAECAwAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQABwAAACwAAAAAkAGQAQAI/wABCBxIsKDBgwgT' +
  'KlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3K' +
  'tKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHj' +
  'x5AjS55MubLly5gza97MubPnz6BDix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59Cj' +
  'S59Ovbr169iza9/Ovbv37+DDi/8fT768+fPo06tfz769+/fw48ufT7++/fv48+vfz7+///8ABijggAQWaOCBCCao4IIMNujggxBG' +
  'KOGEFFZo4YUYZqjhhhx26OGHIIYo4ogklmjiiSimqOKKLLbo4oswxijjjDTWaOONOOao44489ujjj0AGKeSQRBZp5JFIJqnkkkw2' +
  '6eSTUEYp5ZRUVmnllVhmqeWWXHbp5ZdghinmmGSWaeaZaKap5ppstunmm3DGKeecdNZp55145qnnnnz26eefgAYq6KCEFmrooYgm' +
  'quiijDbq6KOQRirppJRWaumlmGaq6aacdurpp6CGKuqopJZq6qmopqrqqqy26uqrsMaoKuustNZq66245qrrrrz26uuvwAYr7LDE' +
  'Fmvsscgmq+yyzDbr7LPQRivttNRWa+212Gar7bbcduvtt+CGK+645JZr7rnopqvuuuy26+678MYr77z01mvvvfjmq+++/Pbr778A' +
  'ByzwwAQXbPDBCCes8MIMN+zwwxBHLPHEFFds8cUYZ6zxxhx37PHHIIcs8sgkl2zyySinrPLKLLfs8sswxyzzzDTXnFZAACH5BAEH' +
  'AAEALAAAAACQAZABgfDICgAAAAAAAAAAAAj/AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKFOq' +
  'XMmypcuXMGPKnEmzps2bOHPq3Mmzp8+fQIMKHUq0qNGjSJMqXcq0qdOnUKNKnUq1qtWrWLNq3cq1q9evYMOKHUu2rNmzaNOqXcu2' +
  'rdu3cOPKnUu3rt27ePPq3cu3r9+/gAMLHky4sOHDiBMrXsy4sePHkCNLnky5suXLmDNr3sy5s+fPoEOLHk26tOnTqFOrXs26tevX' +
  'sGPLnk27tu3buHPr3s27t+/fwIMLH068uPHjyJMrX868ufPn0KNLn069uvXr2LNr3869u/fv4MOL/x9Pvrz58+jTq1/Pvr379/Dj' +
  'y59Pv779+/jz69/Pv7///wAGKOCABBZo4IEIJqjgggw26OCDEEYo4YQUVmjhhRhmqOGGHHbo4YcghijiiCSWaOKJKKao4oostuji' +
  'izDGKOOMNNZo44045qjjjjz26OOPQAYp5JBEFmnkkUgmqeSSTDbp5JNQRinllFRWaeWVWGap5ZZcdunll2CGKeaYZJZp5plopqnm' +
  'mmy26eabcMYp55x01mnnnXjmqeeefPbp55+ABirooIQWauihiCaq6KKMNuroo5BGKumklFZq6aWYZqrpppx26umnoIYq6qiklmrq' +
  'qaimquqqrLbq6quwxqgq66y01mrrrbjmquuuvPbq66/ABivssMQWa+yxyCar7LLMNuvss9BGK+201FZr7bXYZqvtttx26+234IYr' +
  '7rjklmvuueimq+667Lbr7rvwxivvvPTWa++9+Oar77789uvvvwAHLPDABBds8MEIJ6zwwgw37PDDEEcs8cQUV2zxxRhnrPHGHHfs' +
  '8ccghyzyyCSXbPLJKKes8sost+zyyzDHLPPMNNecVkAAIfkEAQcAAQAsAAAAAJABkAGBWlr6AAAAAAAAAAAACP8AAQgcSLCgwYMI' +
  'EypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybKly5cwY8qcSbOmzZs4c+rcybOnz59AgwodSrSo0aNIkypd' +
  'yrSp06dQo0qdSrWq1atYs2rdyrWr169gw4odS7as2bNo06pdy7at27dw48qdS7eu3bt48+rdy7ev37+AAwseTLiw4cOIEytezLix' +
  '48eQI0ueTLmy5cuYM2vezLmz58+gQ4seTbq06dOoU6tezbq169ewY8ueTbu27du4c+vezbu379/AgwsfTry48ePIkytfzry58+fQ' +
  'o0ufTr269evYs2vfzr279+/gw4v/H0++vPnz6NOrX8++vfv38OPLn0+/vv37+PPr38+/v///AAYo4IAEFmjggQgmqOCCDDbo4IMQ' +
  'RijhhBRWaOGFGGao4YYcdujhhyCGKOKIJJZo4okopqjiiiy26OKLMMYo44w01mjjjTjmqOOOPPbo449ABinkkEQWaeSRSCap5JJM' +
  'Nunkk1BGKeWUVFZp5ZVYZqnlllx26eWXYIYp5phklmnmmWimqeaabLbp5ptwxinnnHTWaeedeOap55589unnn4AGKuighBZq6KGI' +
  'Jqrooow26uijkEYq6aSUVmrppZhmqummnHbq6aeghirqqKSWauqpqKaq6qqsturqq7DGqCrrrLTWauutuOaq66689urrr8AGK+yw' +
  'xBZr7LHIJqvsssw26+yz0EYr7bTUVmvttdhmq+223Hbr7bfghivuuOSWa+656Kar7rrstuvuu/DGK++89NZr77345qvvvvz26++/' +
  'AAcs8MAEF2zwwQgnrPDCDDfs8MMQRyzxxBRXbPHFGGes8cYcd+zxxyCHLPLIJJds8skop6zyyiy37PLLMMcs88w015xWQAA7'
  '';

/** syn-h-wide.gif（2505 字节） */
export const GIF_WIDE =
  'R0lGODlhWALIAIEAAMgAAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQABgAAACwAAAAAWALIAAAI/wABCBxIsKDBgwgT' +
  'KlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3K' +
  'tKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHj' +
  'x5AjS55MubLly5gza97MubPnz6BDix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59Cj' +
  'S59Ovbr169iza9/Ovbv37+DDi/8fT768+fPo06tfz769+/fw48ufT7++/fv48+vfz7+///8ABijggAQWaOCBCCao4IIMNujggxBG' +
  'KOGEFFZo4YUYZqjhhhx26OGHIIYo4ogklmjiiSimqOKKLLbo4oswxijjjDTWaOONOOao44489ujjj0AGKeSQRBZp5JFIJqnkkkw2' +
  '6eSTUEYp5ZRUVmnllVhmqeWWXHbp5ZdghinmmGSWaeaZaKap5ppstunmm3DGKeecdNZp55145qnnnnz26eefgAYq6KCEFmrooYgm' +
  'quiijDbq6KOQRirppJRWaumlmGaq6aacdurpp6CGKuqopJZq6qmopqrqqqy26uqrsMZJKuustNZq66245qrrrrz26uuvwAYr7LDE' +
  'Fmvsscgmq+yyzDbr7LPQRivttNRWa+212Gar7bbcduvtt+CGK+645JZr7rnopjtcQAAh+QQBBgABACwAAAAAWALIAIEAyAAAAAAA' +
  'AAAAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJ' +
  's6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/f' +
  'v4ADCx5MuLDhw4gTK17MuLHjx5AjS55MubLly5gza97MubPnz6BDix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CD' +
  'Cx9OvLjx48iTK1/OvLnz59CjS59Ovbr169iza9/Ovbv37+DDi/8fT768+fPo06tfz769+/fw48ufT7++/fv48+vfz7+///8ABijg' +
  'gAQWaOCBCCao4IIMNujggxBGKOGEFFZo4YUYZqjhhhx26OGHIIYo4ogklmjiiSimqOKKLLbo4oswxijjjDTWaOONOOao44489ujj' +
  'j0AGKeSQRBZp5JFIJqnkkkw26eSTUEYp5ZRUVmnllVhmqeWWXHbp5ZdghinmmGSWaeaZaKap5ppstunmm3DGKeecdNZp55145qnn' +
  'nnz26eefgAYq6KCEFmrooYgmquiijDbq6KOQRirppJRWaumlmGaq6aacdurpp6CGKuqopJZq6qmopqrqqqy26uqrsMZJKuustNZq' +
  '66245qrrrrz26uuvwAYr7LDEFmvsscgmq+yyzDbr7LPQRivttNRWa+212Gar7bbcduvtt+CGK+645JZr7rnopjtcQAAh+QQBBgAB' +
  'ACwAAAAAWALIAIEAAMgAAAAAAAAAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJ' +
  'sqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3b' +
  't3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjS55MubLly5gza97MubPnz6BDix5NurTp06hTq17NurXr17Bj' +
  'y55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59CjS59Ovbr169iza9/Ovbv37+DDi/8fT768+fPo06tfz769+/fw48uf' +
  'T7++/fv48+vfz7+///8ABijggAQWaOCBCCao4IIMNujggxBGKOGEFFZo4YUYZqjhhhx26OGHIIYo4ogklmjiiSimqOKKLLbo4osw' +
  'xijjjDTWaOONOOao44489ujjj0AGKeSQRBZp5JFIJqnkkkw26eSTUEYp5ZRUVmnllVhmqeWWXHbp5ZdghinmmGSWaeaZaKap5pps' +
  'tunmm3DGKeecdNZp55145qnnnnz26eefgAYq6KCEFmrooYgmquiijDbq6KOQRirppJRWaumlmGaq6aacdurpp6CGKuqopJZq6qmo' +
  'pqrqqqy26uqrsMZJKuustNZq66245qrrrrz26uuvwAYr7LDEFmvsscgmq+yyzDbr7LPQRivttNRWa+212Gar7bbcduvtt+CGK+64' +
  '5JZr7rnopjtcQAAh+QQBBgABACwAAAAAWALIAIHIyAAAAAAAAAAAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzI' +
  'saPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavX' +
  'r2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjS55MubLly5gza97MubPnz6BD' +
  'ix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59CjS59Ovbr169iza9/Ovbv37+DDi/8f' +
  'T768+fPo06tfz769+/fw48ufT7++/fv48+vfz7+///8ABijggAQWaOCBCCao4IIMNujggxBGKOGEFFZo4YUYZqjhhhx26OGHIIYo' +
  '4ogklmjiiSimqOKKLLbo4oswxijjjDTWaOONOOao44489ujjj0AGKeSQRBZp5JFIJqnkkkw26eSTUEYp5ZRUVmnllVhmqeWWXHbp' +
  '5ZdghinmmGSWaeaZaKap5ppstunmm3DGKeecdNZp55145qnnnnz26eefgAYq6KCEFmrooYgmquiijDbq6KOQRirppJRWaumlmGaq' +
  '6aacdurpp6CGKuqopJZq6qmopqrqqqy26uqrsMZJKuustNZq66245qrrrrz26uuvwAYr7LDEFmvsscgmq+yyzDbr7LPQRivttNRW' +
  'a+212Gar7bbcduvtt+CGK+645JZr7rnopjtcQAA7'
  '';
