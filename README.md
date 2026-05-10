# Calculateur de Rentabilité Immobilière

Une application web qui analyse automatiquement les annonces immobilières (BienIci, SeLoger) et calcule la rentabilité d'un investissement locatif.

## Fonctionnalités

- **Extraction automatique** : Colle une URL d'annonce et l'application extrait automatiquement :
  - Prix du bien
  - Charges de copropriété
  - Taxe foncière
  - Nombre de chambres
  - Surface

- **Paramètres ajustables** avec valeurs par défaut :
  - Travaux : 0€
  - Meubles : 3 000€
  - Apport : 10%
  - Durée : 20 ans
  - Taux crédit : 3.50%
  - Taux assurance : 0.30%
  - Assurance PNO : ~3€/m²
  - Loyer mensuel : 600€ par chambre
  - Frais de notaire : 8%

- **Calculs de rentabilité** :
  - Mensualité totale
  - Cashflow mensuel
  - Rendement brut et net
  - Prix d'équilibre cashflow
  - Rendement annualisé sur 20 ans

- **Visualisation** : Graphique interactif montrant le coût mensuel en fonction du prix

## Installation

```bash
npm install
```

## Configuration

Créer un fichier `.env` avec votre clé API OpenAI :

```
OPENAI_SECRET_KEY=sk-...
```

## Utilisation

```bash
npm start
```

Ouvrir http://localhost:3001 dans votre navigateur.

## Sites supportés

- bienici.com
- seloger.com
- Et potentiellement d'autres sites d'annonces immobilières françaises

## Technologie

- **Backend** : Node.js, Express, OpenAI API
- **Frontend** : HTML/CSS/JavaScript vanilla, Chart.js
- **Extraction** : Cheerio pour le parsing HTML, GPT-4o-mini pour l'extraction intelligente
