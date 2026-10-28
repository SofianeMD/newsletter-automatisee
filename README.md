# Newsletter automatisée

Pipeline complet qui génère et publie chaque matin une newsletter, sans action manuelle.

## Architecture

```text
08h10  Collecte des actualités (flux RSS, ~20 sources)
  ↓
Rédaction de l'édition (dossier + brèves + rubrique « hors radar »)
  ↓
Génération du PDF (carrousel) + texte du post
  ↓
Publication automatique sur une page LinkedIn via un outil partenaire (Buffer)
```

## Choix techniques

- Zéro action manuelle : publication par défaut
- PDF carrousel généré par un template HTML/CSS → réutilisable chaque jour
- Envoi via l'API d'un outil partenaire officiel LinkedIn

## Roadmap

- [x] Édition test (maquette validée)
- [ ] Mise en production quotidienne
- [ ] Tableau de bord de suivi des publications
